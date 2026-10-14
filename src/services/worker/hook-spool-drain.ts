import { mkdirSync, watch as fsWatch } from 'fs';
import express, { type Request, type RequestHandler, type Response } from 'express';
import {
  HOOK_SPOOL_FORWARD_CONTENT_TYPE,
  HOOK_SPOOL_SESSION_END_UNKNOWN_GRACE_MS,
  HookSpool,
  type HookSpoolConsumedMarkers,
  type HookSpoolDrainResult,
  type HookSpoolEntry,
  type HookSpoolForwardReply,
  validateHookSpoolEntry,
} from '../../shared/hook-spool.js';
import type { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { ingestAdvisorCalls, ingestObservation, ingestSessionEnd, ingestSummarize, requireIngestContext } from './http/shared.js';

const SAFETY_SWEEP_INTERVAL_MS = 30_000;

/**
 * Hand one spool entry to the SAME ingest function its HTTP route uses.
 * true = done (accepted or deliberately skipped) → unlink; false = keep;
 * 'expired' = can never succeed → the drain moves it to expired/ (see
 * HookSpool.drain).
 * `markHandedOff` goes to ingest, which calls it synchronously at the exact
 * point the entry is irrevocably accepted (see HookSpool.drain).
 */
async function ingestHookSpoolEntry(entry: HookSpoolEntry, markHandedOff: () => void): Promise<boolean | 'expired'> {
  switch (entry.kind) {
    case 'observation':
    case 'file_edit': {
      // Attribute it to the prompt that was current when the hook saw it, not
      // the one current now (the drain may run prompts later).
      const result = await ingestObservation({ ...entry.payload, enqueuedAtEpochMs: entry.enqueuedAtEpochMs }, { markHandedOff });
      if (!result.ok) {
        logger.warn('HOOK', 'Spooled observation was not ingested; keeping it for the next drain', {
          kind: entry.kind,
          contentSessionId: entry.payload.contentSessionId,
          toolName: entry.payload.toolName,
          reason: result.reason,
        });
        return false;
      }
      return true;
    }
    case 'summarize':
      // unknown_session: init may not have landed yet (it raced the same
      // outage) — keep the entry, exactly like the old SessionEnd replay.
      return (await ingestSummarize({ ...entry.payload, enqueuedAtEpochMs: entry.enqueuedAtEpochMs }, undefined, { markHandedOff })).status !== 'unknown_session';
    case 'session_end': {
      // unknown_session here means the worker is up and its DB has no such
      // session: a session registers within moments of starting or never, so
      // past the grace window the end can never succeed and the entry only
      // clogs the spool until the retry window expires it (issue #4629). The
      // window itself just covers the init race. A DB outage throws instead
      // of returning unknown_session, so this cannot retire an entry that an
      // outage made undeliverable.
      const outcome = (await ingestSessionEnd(entry.payload, undefined, { markHandedOff })).status;
      if (outcome !== 'unknown_session') return true;
      return Date.now() - entry.enqueuedAtEpochMs > HOOK_SPOOL_SESSION_END_UNKNOWN_GRACE_MS ? 'expired' : false;
    }
    case 'advisor_calls':
      ingestAdvisorCalls(entry.payload, undefined, { markHandedOff });
      return true;
  }
}

/** The worker DB's hook_spool_consumed table: makes the hand-off exactly-once across restarts. */
export function hookSpoolConsumedMarkers(store: SessionStore): HookSpoolConsumedMarkers {
  return {
    isConsumed: entryKey => store.isHookSpoolEntryConsumed(entryKey),
    markConsumed: (entryKey, consumedAtEpochMs) => store.markHookSpoolEntryConsumed(entryKey, consumedAtEpochMs),
    clearConsumed: entryKey => store.clearHookSpoolEntryConsumed(entryKey),
    pruneConsumedBefore: epochMs => store.pruneHookSpoolConsumedMarkersBefore(epochMs),
  };
}

/**
 * A hook's forwarded entries (POST /api/spool/entries), written into this
 * worker's spool under their own keys and timestamps, so the drain takes them
 * like entries a hook here wrote. The reply names the entries now durable
 * here, and the hook removes only those. A hook that spools into this very
 * directory is told so, and nothing is written.
 */
export function acceptForwardedHookSpoolEntries(
  spool: HookSpool,
  body: unknown,
): { ok: true; reply: HookSpoolForwardReply } | { ok: false; error: string } {
  const request = body as { spoolId?: unknown; entries?: unknown } | null;
  if (request === null || typeof request !== 'object' || typeof request.spoolId !== 'string' || !Array.isArray(request.entries)) {
    return { ok: false, error: 'Body must be {spoolId: string, entries: array}' };
  }
  if (request.spoolId === spool.spoolId()) {
    return { ok: true, reply: { sameSpool: true, accepted: [] } };
  }

  const accepted: number[] = [];
  request.entries.forEach((raw, index) => {
    const entry = validateHookSpoolEntry(raw);
    if ('corruptReason' in entry) {
      logger.warn('HOOK', 'Refused a forwarded hook spool entry; the hook keeps it', { index, reason: entry.corruptReason });
      return;
    }
    try {
      spool.enqueueEntry(entry);
      accepted.push(index);
    } catch (error) {
      logger.error('HOOK', 'Could not write a forwarded hook spool entry; the hook keeps it', {
        kind: entry.kind,
        contentSessionId: entry.payload.contentSessionId,
      }, error instanceof Error ? error : new Error(String(error)));
    }
  });
  return { ok: true, reply: { sameSpool: false, accepted } };
}

/**
 * POST /api/spool/entries: the body parser and the handler. The route's own
 * content type keeps the app-wide 5 MB JSON parser off it.
 */
export function hookSpoolEntriesHandlers(spool: HookSpool, requestDrain: () => void): RequestHandler[] {
  return [
    express.raw({ type: HOOK_SPOOL_FORWARD_CONTENT_TYPE, limit: '64mb' }),
    (req: Request, res: Response) => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : '');
      } catch {
        res.status(400).json({ error: `Body must be JSON sent as ${HOOK_SPOOL_FORWARD_CONTENT_TYPE}` });
        return;
      }
      const result = acceptForwardedHookSpoolEntries(spool, body);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      requestDrain();
      res.status(200).json(result.reply);
    },
  ];
}

export async function drainHookSpool(spool: HookSpool = new HookSpool()): Promise<HookSpoolDrainResult> {
  const result = await spool.drain(ingestHookSpoolEntry, hookSpoolConsumedMarkers(requireIngestContext().dbManager.getSessionStore()));
  if (result.drained > 0 || result.quarantined > 0 || result.expired > 0) {
    logger.info('HOOK', 'Drained hook spool', { ...result });
  }
  return result;
}

/**
 * Drives drainHookSpool: single-flight (a request during a drain schedules
 * exactly one more pass, never a concurrent one — FileTailer's requestRead
 * pattern), triggered by an fs.watch of the spool directory, the hook's nudge
 * route, and a slow safety sweep for anything a watch event missed.
 */
export class HookSpoolDrainer {
  private drainTask: Promise<void> | null = null;
  private drainPending = false;
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly spool: HookSpool = new HookSpool(),
    private readonly drain: (spool: HookSpool) => Promise<unknown> = drainHookSpool,
  ) {}

  /** Resolves when the drain that covers this request has finished. */
  requestDrain(): Promise<void> {
    if (this.drainTask) {
      this.drainPending = true;
      return this.drainTask;
    }

    this.drainTask = this.drainUntilSettled().finally(() => {
      this.drainTask = null;
      // A request that landed after the loop's last check but before this
      // callback ran would otherwise wait for the next trigger.
      if (this.drainPending) void this.requestDrain();
    });
    return this.drainTask;
  }

  start(): void {
    this.requestDrain();

    if (!this.watcher) {
      try {
        mkdirSync(this.spool.directory, { recursive: true });
        this.watcher = fsWatch(this.spool.directory, { persistent: false }, () => {
          this.requestDrain();
        });
        this.watcher.on('error', (error: Error) => {
          logger.warn('HOOK', 'Hook spool watch failed; relying on nudges and the safety sweep', {
            directory: this.spool.directory,
          }, error);
          this.watcher?.close();
          this.watcher = null;
        });
      } catch (error: unknown) {
        logger.warn('HOOK', 'Could not watch the hook spool; relying on nudges and the safety sweep', {
          directory: this.spool.directory,
        }, error instanceof Error ? error : new Error(String(error)));
        this.watcher = null;
      }
    }

    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.requestDrain(), SAFETY_SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private async drainUntilSettled(): Promise<void> {
    do {
      this.drainPending = false;
      try {
        await this.drain(this.spool);
      } catch (error: unknown) {
        logger.warn('HOOK', 'Hook spool drain pass failed; the next trigger retries', {
          directory: this.spool.directory,
        }, error instanceof Error ? error : new Error(String(error)));
      }
    } while (this.drainPending);
  }
}
