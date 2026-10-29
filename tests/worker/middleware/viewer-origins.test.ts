import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { isForeignViewerRequest, isViewerOriginHost } from '../../../src/services/worker/http/viewer-origins.js';

// husni fork: a request sent to an origin named in CLAUDE_MEM_ALLOWED_ORIGINS
// reaches My Work as loopback does, and that origin's page may write.

const root = join(import.meta.dir, '..', '..', '..');
const ORIGINS = ['http://proxenos.example.ts.net:37701', 'https://proxenos.exe.xyz'];

describe('isViewerOriginHost', () => {
  it('matches the host name of a configured origin, with or without a port', () => {
    expect(isViewerOriginHost('proxenos.example.ts.net:37701', ORIGINS)).toBe(true);
    expect(isViewerOriginHost('PROXENOS.EXE.XYZ', ORIGINS)).toBe(true);
    expect(isViewerOriginHost('proxenos.exe.xyz:443', ORIGINS)).toBe(true);
  });

  it('refuses any other name, an address, and a missing Host', () => {
    expect(isViewerOriginHost('other.example', ORIGINS)).toBe(false);
    expect(isViewerOriginHost('100.64.0.1:37701', ORIGINS)).toBe(false);
    expect(isViewerOriginHost(undefined, ORIGINS)).toBe(false);
    expect(isViewerOriginHost('proxenos.exe.xyz', [])).toBe(false);
  });
});

describe('isForeignViewerRequest', () => {
  const request = (origin: string | undefined, host: string) => ({ headers: { origin, host } });

  it('takes a configured origin as the viewer itself', () => {
    expect(isForeignViewerRequest(request('https://proxenos.exe.xyz', 'proxenos.exe.xyz'), () => ORIGINS)).toBe(false);
    expect(isForeignViewerRequest(request('http://proxenos.example.ts.net:37701', 'proxenos.example.ts.net:37701'), () => ORIGINS)).toBe(false);
  });

  it('keeps upstream judging every other page', () => {
    expect(isForeignViewerRequest(request('https://evil.example', 'proxenos.exe.xyz'), () => ORIGINS)).toBe(true);
    expect(isForeignViewerRequest(request('http://localhost:3000', '127.0.0.1:37701'), () => ORIGINS)).toBe(true);
    expect(isForeignViewerRequest(request('http://127.0.0.1:37701', '127.0.0.1:37701'), () => ORIGINS)).toBe(false);
    expect(isForeignViewerRequest(request(undefined, '127.0.0.1:37701'), () => ORIGINS)).toBe(false);
    expect(isForeignViewerRequest(request('https://proxenos.exe.xyz', 'proxenos.exe.xyz'), () => [])).toBe(true);
  });
});

interface Case { method: 'GET' | 'POST'; path: string; headers: Record<string, string> }

const read = (host: string, extra: Record<string, string> = {}): Case =>
  ({ method: 'GET', path: '/api/work-view', headers: { host, ...extra } });
const write = (host: string, origin: string): Case => ({
  method: 'POST',
  path: '/api/work-view/review',
  headers: { host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
});

/** Runs the two work-view guards in a fresh process whose settings name `allowedOrigins`, and returns each case's status. */
async function statuses(allowedOrigins: string, cases: Case[]): Promise<number[]> {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mem-viewer-origins-'));
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ CLAUDE_MEM_ALLOWED_ORIGINS: allowedOrigins }));
  const source = `
    const express = (await import('express')).default;
    const http = await import('node:http');
    const { workViewLoopbackOnly, requireWorkViewOrigin } = await import(${JSON.stringify(pathToFileURL(join(root, 'src/services/worker/http/routes/WorkViewRoutes.ts')).href)});
    const app = express();
    app.get('/api/work-view', workViewLoopbackOnly, (_req, res) => res.json({ ok: true }));
    app.post('/api/work-view/review', workViewLoopbackOnly, requireWorkViewOrigin, (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    const results = [];
    for (const c of ${JSON.stringify(cases)}) {
      results.push(await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: c.method, path: c.path, headers: c.headers }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end(c.method === 'POST' ? '{}' : undefined);
      }));
    }
    server.close();
    console.log(JSON.stringify(results));
  `;
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_MEM_DATA_DIR: directory, CLAUDE_MEM_TELEMETRY: '0' };
  delete env.CLAUDE_MEM_ALLOWED_ORIGINS;
  delete env.CLAUDE_MEM_PUBLIC_URL;
  try {
    const child = Bun.spawn([process.execPath, '-e', source], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (exit !== 0) throw new Error(`guard scenario exited ${exit}: ${stderr}\n${stdout}`);
    return JSON.parse(stdout.trim().split('\n').pop()!);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

describe('My Work behind a proxy', () => {
  it('answers a configured viewer name, through a proxy too, and still refuses everything else', async () => {
    expect(await statuses(ORIGINS.join(','), [
      read('127.0.0.1:37701'),
      read('proxenos.example.ts.net:37701'),
      read('proxenos.exe.xyz', { 'x-forwarded-for': '100.64.0.1', 'x-forwarded-proto': 'https' }),
      read('100.64.0.1:37701'),
      read('other.example', { 'x-forwarded-for': '100.64.0.1' }),
      write('proxenos.exe.xyz', 'https://proxenos.exe.xyz'),
      write('proxenos.exe.xyz', 'https://evil.example'),
      write('127.0.0.1:37701', 'http://localhost:3000'),
    ])).toEqual([200, 200, 200, 403, 403, 200, 403, 403]);
  }, 20_000);

  it('stays loopback-only when no viewer origin is configured, as upstream ships it', async () => {
    expect(await statuses('', [
      read('127.0.0.1:37701'),
      read('proxenos.example.ts.net:37701'),
      read('proxenos.exe.xyz', { 'x-forwarded-for': '100.64.0.1' }),
      write('proxenos.exe.xyz', 'https://proxenos.exe.xyz'),
    ])).toEqual([200, 403, 403, 403]);
  }, 20_000);
});
