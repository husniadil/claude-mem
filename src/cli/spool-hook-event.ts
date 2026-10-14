import { mkdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import {
  HOOK_SPOOL_FORWARD_CONTENT_TYPE,
  HookSpool,
  type HookSpoolEntry,
  type HookSpoolForwardReply,
  type HookSpoolKind,
  type HookSpoolPayloadByKind,
} from '../shared/hook-spool.js';
import { workerHttpRequest } from '../shared/worker-utils.js';
import { logger } from '../utils/logger.js';

export const SPOOL_NUDGE_TIMEOUT_MS = 250;

/**
 * How long a write hook forwards the spool before it exits. A tool call's hook
 * keeps the nudge's budget, since it runs on every tool call. The Stop hook
 * takes longer, so a backlog the tool calls could not move (a slow link, a
 * worker that was down) reaches the worker by the end of the turn at the
 * latest. SessionEnd stops within the 1.5 s Claude Code gives it, so the hook
 * releases its lock itself rather than being killed while it holds it.
 */
export const SPOOL_FORWARD_BUDGET_MS: Record<HookSpoolKind, number> = {
  observation: SPOOL_NUDGE_TIMEOUT_MS,
  file_edit: SPOOL_NUDGE_TIMEOUT_MS,
  summarize: 5_000,
  advisor_calls: 5_000,
  session_end: 1_000,
};

const FORWARD_BATCH_LIMITS = { maxEntries: 100, maxBytes: 256 * 1024 };
const FORWARD_LOCK_DIRNAME = '.forward-lock';
// Every holder gives up within its budget, so a lock this old lost its holder mid-forward.
const FORWARD_LOCK_STALE_MS = 15_000;
const FORWARD_LOCK_POLL_MS = 20;

export type HookSpoolForwardSend = (entries: HookSpoolEntry[], spoolId: string, timeoutMs: number) => Promise<HookSpoolForwardReply>;

class SpoolEntriesRouteMissingError extends Error {}

const nudgesInFlight = new Set<Promise<void>>();
let pendingNudge: Promise<void> | null = null;
let pendingForward: Promise<void> | null = null;
let forwardAgainBudgetMs = 0;

/**
 * Best-effort poke so a running worker drains now rather than on its fs.watch
 * event or safety sweep. Never spawns a worker, never rejects, and its outcome
 * is irrelevant: the spool file is already durable. Started as soon as the
 * event is spooled; hookCommand awaits it (bounded by the 250 ms request
 * timeout) before process.exit, which would otherwise cut it off mid-flight.
 *
 * A nudge still in flight is shared: a standalone transcript watcher catching
 * up spools many events in a burst, and the worker's drain (or its fs.watch of
 * the spool, or its sweep) takes every entry there is.
 */
export function nudgeWorkerToDrainHookSpool(): Promise<void> {
  if (pendingNudge) return pendingNudge;
  const nudge = (async () => {
    try {
      const response = await workerHttpRequest('/api/spool/nudge', { method: 'POST', timeoutMs: SPOOL_NUDGE_TIMEOUT_MS });
      await response.body?.cancel();
    } catch (error: unknown) {
      logger.debug('HOOK', 'Hook spool nudge not delivered (worker will pick the entry up on its own)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  pendingNudge = nudge;
  nudgesInFlight.add(nudge);
  void nudge.finally(() => {
    nudgesInFlight.delete(nudge);
    if (pendingNudge === nudge) pendingNudge = null;
  });
  return nudge;
}

async function postSpoolEntries(entries: HookSpoolEntry[], spoolId: string, timeoutMs: number): Promise<HookSpoolForwardReply> {
  const response = await workerHttpRequest('/api/spool/entries', {
    method: 'POST',
    headers: { 'Content-Type': HOOK_SPOOL_FORWARD_CONTENT_TYPE },
    body: JSON.stringify({ spoolId, entries }),
    timeoutMs,
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) throw new SpoolEntriesRouteMissingError('the worker has no /api/spool/entries');
    throw new Error(`the worker answered ${response.status}`);
  }
  const reply = (await response.json()) as Partial<HookSpoolForwardReply>;
  return {
    sameSpool: reply.sameSpool === true,
    accepted: Array.isArray(reply.accepted) ? reply.accepted.filter(index => Number.isInteger(index)) : [],
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** The lock's path once this process holds it, or null if another holds it past the deadline. */
async function acquireForwardLock(directory: string, deadline: number): Promise<string | null> {
  const lockPath = join(directory, FORWARD_LOCK_DIRNAME);
  mkdirSync(directory, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockPath);
      return lockPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let heldForMs: number;
    try {
      heldForMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (heldForMs > FORWARD_LOCK_STALE_MS) {
      rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() + FORWARD_LOCK_POLL_MS >= deadline) return null;
    await waitMs(FORWARD_LOCK_POLL_MS);
  }
}

/**
 * Moves the spool's entries to the worker, oldest first, until none are left
 * or the budget runs out. A worker that drains this same directory answers
 * so, which ends it: the request already made that worker drain.
 *
 * One process forwards a spool at a time (a lock directory beside the
 * entries), so two hooks never send the same entry. A hook that finds the
 * lock held waits for it within its budget, since the holder may have listed
 * the directory before this hook's entry was written.
 */
export async function forwardHookSpool(spool: HookSpool, send: HookSpoolForwardSend, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const lockPath = await acquireForwardLock(spool.directory, deadline);
  if (lockPath === null) {
    logger.debug('HOOK', 'Another process is forwarding the hook spool; its entries wait for the next forward', {
      directory: spool.directory,
    });
    return;
  }
  try {
    for (;;) {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) return;
      const result = await spool.forward((entries, spoolId) => send(entries, spoolId, timeoutMs), FORWARD_BATCH_LIMITS);
      if (result.sameSpool || result.remaining === 0 || result.forwarded === 0) return;
    }
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/**
 * Hands the spool to the worker within `budgetMs`, whether the worker reads
 * this disk or not: a worker on another machine, or behind a port forwarded
 * into a container, drains only its own. Never rejects. An entry is removed
 * here only once the worker has written it into its own spool, so whatever
 * did not go stays for the next write hook.
 *
 * A forward still in flight is shared, and a request made meanwhile runs one
 * more pass with the larger of the budgets asked for.
 */
export function forwardHookSpoolToWorker(budgetMs: number): Promise<void> {
  if (pendingForward) {
    forwardAgainBudgetMs = Math.max(forwardAgainBudgetMs, budgetMs);
    return pendingForward;
  }
  const forward = (async () => {
    let passBudgetMs = budgetMs;
    while (passBudgetMs > 0) {
      forwardAgainBudgetMs = 0;
      try {
        await forwardHookSpool(new HookSpool(), postSpoolEntries, passBudgetMs);
      } catch (error: unknown) {
        if (error instanceof SpoolEntriesRouteMissingError) {
          logger.warn('HOOK', 'The worker predates forwarded hook spool entries; unless it drains this disk, they wait here until it is updated', {});
          // A worker on this disk still drains them, and now with a nudge.
          await nudgeWorkerToDrainHookSpool();
        } else {
          logger.debug('HOOK', 'Hook spool not forwarded; its entries wait for the next forward', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      passBudgetMs = forwardAgainBudgetMs;
    }
  })();
  pendingForward = forward;
  nudgesInFlight.add(forward);
  void forward.finally(() => {
    nudgesInFlight.delete(forward);
    if (pendingForward === forward) pendingForward = null;
  });
  return forward;
}

/**
 * Resolves once every nudge and forward this process started has finished,
 * each within its budget (SPOOL_FORWARD_BUDGET_MS of the event it followed).
 */
export async function settleHookSpoolNudges(): Promise<void> {
  await Promise.all([...nudgesInFlight]);
}

/**
 * Write-hook hand-off: persist the event to the hook spool, start forwarding
 * it to the worker, return. The handler makes no awaited worker call and no
 * readiness wait; only hookCommand's exit waits for the forward, within the
 * event's budget.
 */
export function spoolHookEvent<K extends HookSpoolKind>(kind: K, payload: HookSpoolPayloadByKind[K]): string {
  const entryPath = new HookSpool().enqueue(kind, payload);
  logger.debug('HOOK', 'Hook event spooled for the worker', { kind, entryPath });
  void forwardHookSpoolToWorker(SPOOL_FORWARD_BUDGET_MS[kind]);
  return entryPath;
}
