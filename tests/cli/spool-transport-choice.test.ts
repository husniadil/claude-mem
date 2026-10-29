import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

// husni fork: a hook takes upstream's ingest route only with an ingest token,
// and otherwise forwards its spool through POST /api/spool/entries.

const root = join(import.meta.dir, '..', '..');
const requests: string[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  const app = express();
  app.post('/api/spool/entries', (req, res) => {
    requests.push(req.path);
    res.json({ sameSpool: false, accepted: [0] });
  });
  app.use((req, res) => {
    requests.push(req.path);
    res.status(404).end();
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

/** Spools one observation in a fresh process and returns how many ingest uploaders it started. */
async function spoolOne(token: string): Promise<number> {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mem-transport-choice-'));
  const source = `
    const { spyOn } = await import('bun:test');
    const childProcess = await import('child_process');
    const { EventEmitter } = await import('events');
    let uploaders = 0;
    spyOn(childProcess, 'spawn').mockImplementation(() => {
      uploaders++;
      const child = new EventEmitter();
      child.unref = () => child;
      setImmediate(() => child.emit('exit', 0));
      return child;
    });
    const { spoolHookEvent, settleHookSpoolNudges } = await import(${JSON.stringify(pathToFileURL(join(root, 'src/cli/spool-hook-event.ts')).href)});
    spoolHookEvent('observation', { contentSessionId: 's1', platformSource: 'claude', toolName: 'Read', cwd: '/tmp' });
    await settleHookSpoolNudges();
    console.log(JSON.stringify({ uploaders }));
  `;
  try {
    const child = Bun.spawn([process.execPath, '-e', source], {
      cwd: root,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory, CLAUDE_PLUGIN_ROOT: join(root, 'plugin'),
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(port), CLAUDE_MEM_WORKER_AUTOSTART: 'false',
        CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: 'http', CLAUDE_MEM_WORKER_INGEST_TOKEN: token,
        CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_TELEMETRY: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (exit !== 0) throw new Error(`transport scenario exited ${exit}: ${stderr}\n${stdout}`);
    return JSON.parse(stdout.trim().split('\n').pop()!).uploaders;
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

describe('hook spool transport choice', () => {
  it('forwards through /api/spool/entries when no ingest token is set, even to a remote worker', async () => {
    requests.length = 0;
    expect(await spoolOne('')).toBe(0);
    expect(requests).toEqual(['/api/spool/entries']);
  });

  it('hands the spool to the ingest uploader when an ingest token is set', async () => {
    requests.length = 0;
    expect(await spoolOne('test-ingest-token')).toBe(1);
    expect(requests).toEqual([]);
  });
});
