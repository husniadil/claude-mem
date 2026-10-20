import { describe, expect, it } from 'bun:test';
import {
  PRO_TRIAL_MAX_DAYS,
  PRO_TRIAL_LABEL,
  proTrialUrl,
} from '../../src/shared/pro-promo.js';

describe('pro trial label and links', () => {
  it('presents the standard 30 Day Free Trial without hedging its duration', () => {
    expect(PRO_TRIAL_MAX_DAYS).toBe(30);
    expect(PRO_TRIAL_LABEL).toBe('30 Day Free Trial');
  });

  it('tags links with the source only — no trial length hint', () => {
    expect(proTrialUrl('fallback')).toBe('https://cmem.ai/pro?from=fallback');
  });
});
