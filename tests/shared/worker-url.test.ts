import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { buildWorkerUrl, clearPortCache, parseWorkerBaseUrl } from '../../src/shared/worker-utils.js';
import { isRemoteWorkerOnly } from '../../src/shared/worker-spawn-gate.js';
// Freeze paths.ts on the preload data dir before any per-test env override.
import '../../src/shared/paths.js';

describe('parseWorkerBaseUrl', () => {
  it('is null when unset or blank', () => {
    expect(parseWorkerBaseUrl(undefined)).toBeNull();
    expect(parseWorkerBaseUrl('')).toBeNull();
    expect(parseWorkerBaseUrl('   ')).toBeNull();
  });

  it('keeps the scheme, host, port and path prefix, without a trailing slash', () => {
    expect(parseWorkerBaseUrl('https://claude-mem.int.exe.xyz')).toBe('https://claude-mem.int.exe.xyz');
    expect(parseWorkerBaseUrl('https://claude-mem.int.exe.xyz/')).toBe('https://claude-mem.int.exe.xyz');
    expect(parseWorkerBaseUrl('http://10.0.0.5:37701')).toBe('http://10.0.0.5:37701');
    expect(parseWorkerBaseUrl(' https://proxy.example/claude-mem/ ')).toBe('https://proxy.example/claude-mem');
  });

  it('refuses what is not an http or https base URL', () => {
    expect(() => parseWorkerBaseUrl('claude-mem.int.exe.xyz')).toThrow('CLAUDE_MEM_WORKER_URL');
    expect(() => parseWorkerBaseUrl('ftp://claude-mem.int.exe.xyz')).toThrow('CLAUDE_MEM_WORKER_URL');
    expect(() => parseWorkerBaseUrl('https://claude-mem.int.exe.xyz/?x=1')).toThrow('CLAUDE_MEM_WORKER_URL');
    expect(() => parseWorkerBaseUrl('https://claude-mem.int.exe.xyz/#x')).toThrow('CLAUDE_MEM_WORKER_URL');
  });
});

describe('CLAUDE_MEM_WORKER_URL in the settings file', () => {
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `worker-url-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    clearPortCache();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    clearPortCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSettings(overrides: Record<string, string>): void {
    const settings = { ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_DATA_DIR: tempDir, ...overrides };
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
  }

  it('builds request URLs from HOST and PORT when unset', () => {
    writeSettings({ CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: '37701' });

    expect(buildWorkerUrl('/api/health')).toBe('http://127.0.0.1:37701/api/health');
    expect(isRemoteWorkerOnly()).toBe(false);
  });

  it('builds request URLs from the base URL when set, and implies a remote worker', () => {
    writeSettings({
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_PORT: '37701',
      CLAUDE_MEM_WORKER_URL: 'https://claude-mem.int.exe.xyz/',
    });

    expect(buildWorkerUrl('/api/search?query=x')).toBe('https://claude-mem.int.exe.xyz/api/search?query=x');
    expect(isRemoteWorkerOnly()).toBe(true);
  });

  it('fails loudly on a malformed base URL rather than falling back to HOST and PORT', () => {
    writeSettings({ CLAUDE_MEM_WORKER_URL: 'claude-mem.int.exe.xyz' });

    expect(() => buildWorkerUrl('/api/health')).toThrow('CLAUDE_MEM_WORKER_URL');
  });
});
