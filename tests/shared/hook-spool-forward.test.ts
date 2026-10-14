import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HookSpool, type HookSpoolEntry, type HookSpoolForwardReply } from '../../src/shared/hook-spool.js';
import { acceptForwardedHookSpoolEntries } from '../../src/services/worker/hook-spool-drain.js';
import { forwardHookSpool, type HookSpoolForwardSend } from '../../src/cli/spool-hook-event.js';
import { logger } from '../../src/utils/logger.js';

// A hook whose worker drains another disk (another machine, or a port forwarded
// into a container) moves its spool entries there. The rule under test: an
// entry leaves this spool only once the worker has written it into its own.

let root: string;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

function observation(toolUseId: string, toolResponse: unknown = { stdout: 'a' }) {
  return {
    contentSessionId: 'session-1',
    platformSource: 'claude',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    toolResponse,
    cwd: '/repo',
    toolUseId,
  };
}

function entryFiles(spool: HookSpool): string[] {
  return readdirSync(spool.directory).filter(name => name.endsWith('.json')).sort();
}

/** A worker on another disk, answering the way POST /api/spool/entries does. */
function workerOn(workerSpool: HookSpool): HookSpoolForwardSend {
  return async (entries, spoolId) => {
    const result = acceptForwardedHookSpoolEntries(workerSpool, JSON.parse(JSON.stringify({ spoolId, entries })));
    if (!result.ok) throw new Error(result.error);
    return result.reply;
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-mem-hook-spool-forward-'));
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  rmSync(root, { recursive: true, force: true });
});

describe('HookSpool.spoolId', () => {
  it('is made once per directory and kept', () => {
    const first = new HookSpool(join(root, 'a'));
    const again = new HookSpool(join(root, 'a'));
    const other = new HookSpool(join(root, 'b'));

    expect(first.spoolId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(again.spoolId()).toBe(first.spoolId());
    expect(other.spoolId()).not.toBe(first.spoolId());
    // The id file is not an entry: drains and listings never see it.
    expect(first.entries()).toEqual([]);
  });
});

describe('HookSpool.forward', () => {
  it('removes only the entries the worker answered it wrote', async () => {
    const spool = new HookSpool(join(root, 'hook'));
    spool.enqueue('observation', observation('toolu_1'), 1_000);
    spool.enqueue('observation', observation('toolu_2'), 2_000);
    spool.enqueue('observation', observation('toolu_3'), 3_000);

    const result = await spool.forward(async () => ({ sameSpool: false, accepted: [0, 2] }), { maxEntries: 10, maxBytes: 1_000_000 });

    expect(result).toEqual({ forwarded: 2, remaining: 1, sameSpool: false });
    expect(spool.entries().map(entry => entry.enqueuedAtEpochMs)).toEqual([2_000]);
  });

  it('removes nothing when the worker drains this same directory', async () => {
    const spool = new HookSpool(join(root, 'hook'));
    spool.enqueue('observation', observation('toolu_1'));

    const result = await spool.forward(async () => ({ sameSpool: true, accepted: [0] }), { maxEntries: 10, maxBytes: 1_000_000 });

    expect(result.sameSpool).toBe(true);
    expect(spool.entries()).toHaveLength(1);
  });

  it('keeps every entry when the send fails', async () => {
    const spool = new HookSpool(join(root, 'hook'));
    spool.enqueue('observation', observation('toolu_1'));

    await expect(spool.forward(async () => { throw new Error('connection refused'); }, { maxEntries: 10, maxBytes: 1_000_000 }))
      .rejects.toThrow('connection refused');
    expect(spool.entries()).toHaveLength(1);
  });

  it('sends the oldest entries first, within the batch limits but never none', async () => {
    const spool = new HookSpool(join(root, 'hook'));
    spool.enqueue('observation', observation('toolu_new'), 3_000);
    spool.enqueue('observation', observation('toolu_big', { stdout: 'x'.repeat(5_000) }), 1_000);
    spool.enqueue('observation', observation('toolu_mid'), 2_000);

    const batches: string[][] = [];
    const send = async (entries: HookSpoolEntry[]): Promise<HookSpoolForwardReply> => {
      batches.push(entries.map(entry => (entry.payload as { toolUseId: string }).toolUseId));
      return { sameSpool: false, accepted: [] };
    };

    // The oldest entry alone is over maxBytes: it still goes, by itself.
    await spool.forward(send, { maxEntries: 10, maxBytes: 1_000 });
    await spool.forward(send, { maxEntries: 2, maxBytes: 1_000_000 });

    expect(batches).toEqual([['toolu_big'], ['toolu_big', 'toolu_mid']]);
  });
});

describe('acceptForwardedHookSpoolEntries', () => {
  it('writes each entry into the worker spool under its own key and timestamp', () => {
    const hook = new HookSpool(join(root, 'hook'));
    const worker = new HookSpool(join(root, 'worker'));
    hook.enqueue('observation', observation('toolu_1'), 1_000);
    hook.enqueue('summarize', { contentSessionId: 'session-1', platformSource: 'claude', lastAssistantMessage: 'done' }, 2_000);

    const result = acceptForwardedHookSpoolEntries(worker, { spoolId: hook.spoolId(), entries: hook.entries() });

    expect(result).toEqual({ ok: true, reply: { sameSpool: false, accepted: [0, 1] } });
    expect(entryFiles(worker)).toEqual(entryFiles(hook));
    expect(worker.entries()).toEqual(hook.entries());
  });

  it('writes nothing for a hook that spools into the worker spool itself', () => {
    const shared = new HookSpool(join(root, 'shared'));
    shared.enqueue('observation', observation('toolu_1'), 1_000);
    const before = readFileSync(join(shared.directory, entryFiles(shared)[0]!), 'utf-8');

    const result = acceptForwardedHookSpoolEntries(shared, { spoolId: shared.spoolId(), entries: shared.entries() });

    expect(result).toEqual({ ok: true, reply: { sameSpool: true, accepted: [] } });
    expect(readFileSync(join(shared.directory, entryFiles(shared)[0]!), 'utf-8')).toBe(before);
  });

  it('refuses a corrupt entry and accepts the rest of the batch', () => {
    const worker = new HookSpool(join(root, 'worker'));
    const valid = { kind: 'observation', payload: observation('toolu_ok'), enqueuedAtEpochMs: 1_000 };
    const corrupt = { kind: 'observation', payload: { contentSessionId: 'session-1' }, enqueuedAtEpochMs: 2_000 };

    const result = acceptForwardedHookSpoolEntries(worker, { spoolId: 'another-spool', entries: [corrupt, valid] });

    expect(result).toEqual({ ok: true, reply: { sameSpool: false, accepted: [1] } });
    expect(worker.entries()).toHaveLength(1);
  });

  it('rejects a body that is not a forward request', () => {
    const worker = new HookSpool(join(root, 'worker'));

    expect(acceptForwardedHookSpoolEntries(worker, { entries: [] }).ok).toBe(false);
    expect(acceptForwardedHookSpoolEntries(worker, { spoolId: 'x', entries: 'nope' }).ok).toBe(false);
    expect(acceptForwardedHookSpoolEntries(worker, null).ok).toBe(false);
  });
});

describe('forwardHookSpool', () => {
  it('moves the whole spool to a worker on another disk, batch after batch', async () => {
    const hook = new HookSpool(join(root, 'hook'));
    const worker = new HookSpool(join(root, 'worker'));
    for (let i = 0; i < 250; i++) hook.enqueue('observation', observation(`toolu_${i}`), 1_000 + i);
    const expected = hook.entries();

    await forwardHookSpool(hook, workerOn(worker), 10_000);

    expect(hook.entries()).toEqual([]);
    expect(worker.entries()).toEqual(expected);
    // The lock is gone with the forward.
    expect(readdirSync(hook.directory).filter(name => name !== '.spool-id')).toEqual([]);
  });

  it('keeps everything for a worker that drains the same directory', async () => {
    const shared = new HookSpool(join(root, 'shared'));
    shared.enqueue('observation', observation('toolu_1'));

    await forwardHookSpool(shared, workerOn(shared), 10_000);

    expect(shared.entries()).toHaveLength(1);
  });

  it('keeps everything when the worker does not answer', async () => {
    const hook = new HookSpool(join(root, 'hook'));
    hook.enqueue('observation', observation('toolu_1'));

    await expect(forwardHookSpool(hook, async () => { throw new Error('timed out'); }, 10_000)).rejects.toThrow('timed out');

    expect(hook.entries()).toHaveLength(1);
    expect(readdirSync(hook.directory)).not.toContain('.forward-lock');
  });

  it('leaves the spool to a live forward that holds the lock past the budget', async () => {
    const hook = new HookSpool(join(root, 'hook'));
    hook.enqueue('observation', observation('toolu_1'));
    mkdirSync(join(hook.directory, '.forward-lock'));
    let sends = 0;

    await forwardHookSpool(hook, async () => { sends++; return { sameSpool: false, accepted: [0] }; }, 100);

    expect(sends).toBe(0);
    expect(hook.entries()).toHaveLength(1);
  });

  it('takes over a lock its holder left behind', async () => {
    const hook = new HookSpool(join(root, 'hook'));
    const worker = new HookSpool(join(root, 'worker'));
    hook.enqueue('observation', observation('toolu_1'));
    const lockPath = join(hook.directory, '.forward-lock');
    mkdirSync(lockPath);
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    await forwardHookSpool(hook, workerOn(worker), 1_000);

    expect(hook.entries()).toEqual([]);
    expect(worker.entries()).toHaveLength(1);
  });
});
