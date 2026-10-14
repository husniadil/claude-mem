import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

/**
 * husni fork: with CLAUDE_MEM_WORKER_AUTOSTART=false the worker lives elsewhere
 * (proxenos), and nothing is captured locally while it is down. So a down
 * worker still feeds the fail-loud counter, and the notice names the worker
 * rather than a local restart that would do nothing.
 *
 * Runs in a fresh bun process with its own CLAUDE_MEM_DATA_DIR, like
 * worker-outage.test.ts, so the real ~/.claude-mem failure state is untouched.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..');
const WORKER_UTILS_URL = pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts')).href;
const sandboxDirs: string[] = [];

afterEach(() => {
  for (const dir of sandboxDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A port nothing listens on: bound once by the OS, then released. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function runWithDownWorker(settings: Record<string, string>, body: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-outage-autostart-'));
  sandboxDirs.push(dataDir);
  const port = await freePort();
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_WORKER_PORT: String(port),
    ...settings,
  }));
  const source = `
    const w = await import(${JSON.stringify(WORKER_UTILS_URL)});
    const out = {};
    ${body}
    process.stdout.write('OUT=' + JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, '-e', source], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: dataDir,
      CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '2',
      CLAUDE_MEM_TELEMETRY: '0',
    },
  });
  const stdout = new TextDecoder().decode(child.stdout);
  const match = /OUT=(.*)$/s.exec(stdout);
  return { port, exitCode: child.exitCode, output: match ? JSON.parse(match[1]) : null };
}

describe('a down worker with CLAUDE_MEM_WORKER_AUTOSTART=false (husni fork)', () => {
  it('is counted, and the notice names the worker instead of a local restart', async () => {
    const result = await runWithDownWorker({ CLAUDE_MEM_WORKER_AUTOSTART: 'false' }, `
      out.reasons = [];
      for (let i = 0; i < 2; i++) {
        const r = await w.executeWithWorkerFallback('/api/health', 'GET', undefined, { timeoutMs: 2000 });
        out.reasons.push(r.reason);
      }
      out.notice = await w.consumeWorkerOutageNotice('session-a');
      out.again = await w.consumeWorkerOutageNotice('session-a');
    `);

    expect(result.exitCode).toBe(0);
    expect(result.output.reasons).toEqual(['worker_autostart_disabled', 'worker_autostart_disabled']);
    expect(result.output.notice).toContain('unreachable for 2 consecutive hooks');
    expect(result.output.notice).toContain(`http://127.0.0.1:${result.port}`);
    expect(result.output.notice).toContain('CLAUDE_MEM_WORKER_AUTOSTART=false');
    expect(result.output.notice).not.toContain('npx claude-mem restart');
    // Once per session per outage, as upstream's notice is.
    expect(result.output.again).toBeNull();
  }, 30_000);
});
