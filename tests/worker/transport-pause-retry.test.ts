import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';

const { SessionRoutes, TRANSPORT_RETRY_DELAYS_MS } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

function makeSession(): ActiveSession {
  return {
    sessionDbId: 88,
    contentSessionId: 'content-88',
    memorySessionId: 'memory-88',
    project: 'project',
    platformSource: 'claude',
    userPrompt: 'prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 3,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildRoutes(session: ActiveSession, startSession: () => Promise<void>, pending: () => number) {
  let finalizeCalls = 0;
  const sessionManager = {
    getSession: () => session,
    getMessageBuffer: () => ({ getPendingCount: pending, peekTypes: () => [] }),
    removeSessionImmediate: () => {},
  };
  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession } as any,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => { finalizeCalls += 1; } } as any,
  );
  return { routes, finalizeCalls: () => finalizeCalls };
}

describe('observer retries a transport pause on a bounded schedule', () => {
  const realDelays = [...TRANSPORT_RETRY_DELAYS_MS];

  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
    // Real delays are minutes; the schedule's shape is what is under test.
    TRANSPORT_RETRY_DELAYS_MS.splice(0, TRANSPORT_RETRY_DELAYS_MS.length, 1, 1, 1);
  });

  afterEach(() => {
    TRANSPORT_RETRY_DELAYS_MS.splice(0, TRANSPORT_RETRY_DELAYS_MS.length, ...realDelays);
  });

  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  it('starts a new generation after an overloaded provider, without another captured tool call', async () => {
    // The failure this guards: a 529 paused the observer with 68 items buffered,
    // the Claude Code session had already ended, and nothing ever resumed it.
    const session = makeSession();
    let starts = 0;
    const { routes, finalizeCalls } = buildRoutes(session, async () => {
      starts += 1;
      if (starts === 1) {
        session.abortReason = 'transport:observer_text';
        return;
      }
      await new Promise<void>(() => {});
    }, () => 68);

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await wait(30);

    expect(starts).toBe(2);
    expect(finalizeCalls()).toBe(0);
  });

  it('stops retrying once the schedule is spent', async () => {
    const session = makeSession();
    let starts = 0;
    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'transport:turn_timeout';
    }, () => 5);

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await wait(80);

    // The first start plus one per scheduled delay, and then nothing.
    expect(starts).toBe(1 + TRANSPORT_RETRY_DELAYS_MS.length);
    expect(session.transportRetryAttempts).toBe(TRANSPORT_RETRY_DELAYS_MS.length);
    expect(session.respawnTimer).toBeUndefined();
  });

  it('does not retry when the pause left nothing buffered', async () => {
    const session = makeSession();
    let starts = 0;
    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'transport:observer_text';
    }, () => 0);

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await wait(30);

    expect(starts).toBe(1);
  });

  it('does not retry an auth pause', async () => {
    const session = makeSession();
    let starts = 0;
    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'auth:observer_text';
    }, () => 5);

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await wait(30);

    expect(starts).toBe(1);
  });
});
