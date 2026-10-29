import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAutoRefresh, workViewRefreshMs } from '../../src/services/worker/http/routes/WorkViewRoutes.js';

// husni fork: CLAUDE_MEM_WORK_VIEW_REFRESH_MINUTES sets how often the automatic refresh checks.
describe('the refresh interval setting', () => {
  it('takes whole minutes from 1 to 1440', () => {
    expect(workViewRefreshMs('30')).toBe(30 * 60000);
    expect(workViewRefreshMs('1')).toBe(60000);
    expect(workViewRefreshMs('1440')).toBe(1440 * 60000);
  });

  it('reports anything else and keeps the default of 10 minutes', () => {
    for (const value of ['0', '1441', '7.5', 'thirty', '', undefined]) {
      const warnings: string[] = [];
      expect(workViewRefreshMs(value, message => warnings.push(message))).toBe(10 * 60000);
      expect(warnings).toEqual([`CLAUDE_MEM_WORK_VIEW_REFRESH_MINUTES is "${value ?? ''}", not a whole number of minutes from 1 to 1440; using 10.`]);
    }
  });

  it('is what the worker builds its refresh with', () => {
    const dir = mkdtempSync(join(tmpdir(), 'refresh-interval-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_WORK_VIEW_REFRESH_MINUTES: '30' }));
      const worker = defaultAutoRefresh(dir, settingsPath, join(dir, 'setup.json'), () => false, () => '', () => ({ placed: 0, focusAreaIds: [] }));
      expect((worker as unknown as { checkMs: number }).checkMs).toBe(30 * 60000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
