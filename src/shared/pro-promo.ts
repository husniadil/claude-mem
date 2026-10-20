/**
 * cmem Pro trial label and links, for the places that name the trial because
 * the user chose it or is already on it: the installer's provider choice and
 * the notice after the cmem gateway stops serving the account.
 *
 * husni/main shows no unsolicited trial pitch. Upstream carries one in the
 * session-start banner, the per-message context banner, the first-session
 * welcome hint, the installer "Next Steps" block and the viewer header, and
 * this fork drops all five.
 */

/** Landing page for the trial (cmem-pro `src/app/(landing)/pro/page.tsx`). */
export const PRO_TRIAL_URL = 'https://cmem.ai/pro';

/**
 * Where a click came from. Passed through as `?from=` so cmem.ai can attribute
 * the visit per surface.
 */
export type ProPromoSource =
  /** One-time session-start notice after the cmem gateway stops serving the account and memory falls back on-plan. */
  | 'fallback'
  /** Hand-written links in the cursor-hooks setup docs — no TS caller. */
  | 'docs';

/**
 * The standard free trial cmem.ai grants, in days. The server assigns the
 * duration at claim time; promo links carry only source attribution.
 */
export const PRO_TRIAL_MAX_DAYS = 30;

/** Offer label the installer shows. */
export const PRO_TRIAL_LABEL = `${PRO_TRIAL_MAX_DAYS} Day Free Trial`;

/** Trial landing URL tagged with the surface the user clicked from. */
export function proTrialUrl(source: ProPromoSource): string {
  return `${PRO_TRIAL_URL}?from=${source}`;
}
