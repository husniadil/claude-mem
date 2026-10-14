import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HOOK_SPOOL_FORWARD_CONTENT_TYPE, HookSpool } from '../../src/shared/hook-spool.js';
import { createMiddleware } from '../../src/services/worker/http/middleware.js';
import { hookSpoolEntriesHandlers } from '../../src/services/worker/hook-spool-drain.js';
import { logger } from '../../src/utils/logger.js';

// POST /api/spool/entries behind the worker's own app-wide middleware, whose
// JSON parser stops at 5 MB. A forwarded entry is as large as a tool use, so
// the route must be out of that parser's reach.

let root: string;
let server: Server;
let baseUrl: string;
let workerSpool: HookSpool;
let drainRequests: number;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'claude-mem-spool-entries-route-'));
  workerSpool = new HookSpool(join(root, 'worker'));
  drainRequests = 0;
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
  ];
  const app = express();
  createMiddleware().forEach(middleware => app.use(middleware));
  app.post('/api/spool/entries', ...hookSpoolEntriesHandlers(workerSpool, () => { drainRequests++; }));
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port bound');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  loggerSpies.forEach(spy => spy.mockRestore());
  rmSync(root, { recursive: true, force: true });
});

function post(body: string, contentType = HOOK_SPOOL_FORWARD_CONTENT_TYPE): Promise<Response> {
  return fetch(`${baseUrl}/api/spool/entries`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
}

describe('POST /api/spool/entries', () => {
  it('takes an entry larger than the app-wide JSON limit and asks for a drain', async () => {
    const entry = {
      kind: 'observation',
      payload: {
        contentSessionId: 'session-1',
        platformSource: 'claude',
        toolName: 'Read',
        toolInput: { file_path: '/repo/big.txt' },
        toolResponse: { content: 'x'.repeat(6 * 1024 * 1024) },
        cwd: '/repo',
        toolUseId: 'toolu_big',
      },
      enqueuedAtEpochMs: 1_000,
    };

    const response = await post(JSON.stringify({ spoolId: 'hook-spool', entries: [entry] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sameSpool: false, accepted: [0] });
    expect(workerSpool.entries()).toHaveLength(1);
    expect(workerSpool.entries()[0]!.enqueuedAtEpochMs).toBe(1_000);
    expect(drainRequests).toBe(1);
  });

  it('answers sameSpool to a hook that spools into the worker directory', async () => {
    const response = await post(JSON.stringify({ spoolId: workerSpool.spoolId(), entries: [] }));

    expect(await response.json()).toEqual({ sameSpool: true, accepted: [] });
    expect(drainRequests).toBe(1);
  });

  it('refuses a body sent as plain JSON or one that is not JSON', async () => {
    expect((await post(JSON.stringify({ spoolId: 'hook-spool', entries: [] }), 'application/json')).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect(drainRequests).toBe(0);
  });
});
