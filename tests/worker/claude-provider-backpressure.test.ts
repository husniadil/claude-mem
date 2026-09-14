import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { ClaudeProvider } from '../../src/services/worker/ClaudeProvider';
import { SessionMessageBuffer } from '../../src/services/worker/SessionMessageBuffer';
import { ModeManager } from '../../src/services/domain/ModeManager';
import * as recycle from '../../src/services/worker/session/recycle-conversation';
import { OBSERVER_CONVERSATION_MAX_CHARS, observerBatchCeiling } from '../../src/shared/observer-recycle';
import type { PendingMessage } from '../../src/services/worker-types';

/**
 * #4066: the generator yielded each buffered observation as the SDK pulled it.
 * A backlog filled the budget with unanswered messages before the first answer,
 * so every recycle aborted that answer and re-fed the same batch until the
 * overflow pause; and an answer confirmed every claimed message, including the
 * ones queued behind the turn it answered. The generator now sends one turn at
 * a time, one batch per turn, so the claimed ids are exactly what the model is
 * answering.
 */

const mockMode = {
  name: 'code',
  prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
  observation_types: [{ id: 'discovery' }, { id: 'bugfix' }],
  observation_concepts: [],
};

const SESSION_ID = 1;
const STALL_MS = 60;

function makeSession() {
  return {
    sessionDbId: SESSION_ID,
    contentSessionId: 'backpressure-session',
    memorySessionId: null,
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'test prompt',
    conversationHistory: [] as Array<{ role: string; content: string }>,
    lastPromptNumber: 2,
    consecutiveContextOverflows: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    abortController: new AbortController(),
    claimedMessageIds: [] as number[],
    startTime: Date.now(),
  } as any;
}

function observation(i: number, overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    type: 'observation',
    tool_name: 'Bash',
    tool_input: { command: `step ${i}` },
    tool_response: 'x'.repeat(4_000),
    prompt_number: 2,
    ...overrides,
  };
}

/** Pulls from the generator, remembering a pull that is still waiting. */
class Puller {
  private pending: Promise<IteratorResult<any>> | null = null;
  constructor(private readonly gen: AsyncIterator<any>) {}

  /** The next yielded message, 'stalled' if none comes within STALL_MS, or 'done'. */
  async next(): Promise<any | 'stalled' | 'done'> {
    this.pending ??= this.gen.next();
    const outcome = await Promise.race([
      this.pending,
      new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), STALL_MS)),
    ]);
    if (outcome === 'stalled') return 'stalled';
    this.pending = null;
    return outcome.done ? 'done' : outcome.value;
  }
}

describe('ClaudeProvider sends the observer one turn at a time (#4066)', () => {
  let buffer: SessionMessageBuffer;
  let session: any;
  let provider: ClaudeProvider;
  let sessionManager: any;
  let spies: Array<{ mockRestore: () => void }> = [];

  function start(): Puller {
    return new Puller((provider as any).createMessageGenerator(session, { lastCwd: undefined }, { current: null }));
  }

  /** What processAgentResponse does with an answer that parsed. */
  async function answer(): Promise<void> {
    await sessionManager.confirmClaimedMessages(SESSION_ID);
    (provider as any).settleTurn(session);
  }

  beforeEach(() => {
    buffer = new SessionMessageBuffer();
    session = makeSession();
    sessionManager = {
      getMessageBuffer: () => buffer,
      async *getMessageIterator(sessionDbId: number) {
        await this.resetProcessingToPending(sessionDbId);
        for await (const message of buffer.drain({ sessionDbId, signal: session.abortController.signal })) {
          session.claimedMessageIds.push(message._persistentId);
          yield message;
        }
      },
      async resetProcessingToPending(sessionDbId: number) {
        session.claimedMessageIds = [];
        return buffer.resetClaimed(sessionDbId);
      },
      async confirmClaimedMessages() {
        let confirmed = 0;
        for (const id of session.claimedMessageIds) confirmed += buffer.confirm(id);
        session.claimedMessageIds = [];
        return confirmed;
      },
    };
    provider = new ClaudeProvider({} as any, sessionManager);
    spies = [
      spyOn(ModeManager, 'getInstance').mockImplementation(() => ({ getActiveMode: () => mockMode }) as any),
      spyOn(recycle, 'loadSessionStartContext').mockImplementation(async () => ''),
    ];
  });

  afterEach(() => {
    session.abortController.abort();
    for (const spy of spies) spy.mockRestore();
  });

  it('claims nothing while the init turn is unanswered, however large the backlog', async () => {
    for (let i = 0; i < 110; i++) buffer.enqueue(SESSION_ID, observation(i));
    const gen = start();

    expect((await gen.next()).message.content).toBeString();
    expect(await gen.next()).toBe('stalled');

    expect(session.claimedMessageIds).toEqual([]);
    expect(session.consecutiveContextOverflows).toBe(0);
  });

  it('sends a backlog as batches of a quarter of the budget, one per answered turn', async () => {
    for (let i = 0; i < 110; i++) buffer.enqueue(SESSION_ID, observation(i));
    const gen = start();
    await gen.next();

    const ceiling = observerBatchCeiling(OBSERVER_CONVERSATION_MAX_CHARS);
    let sent = 0;
    for (let turn = 0; turn < 3; turn++) {
      await answer();
      const batch = await gen.next();
      expect(await gen.next()).toBe('stalled');

      const size = batch.message.content.length;
      expect(size).toBeGreaterThanOrEqual(ceiling);
      expect(size).toBeLessThan(ceiling + 5_000);
      sent += session.claimedMessageIds.length;
    }

    expect(session.consecutiveContextOverflows).toBe(0);
    expect(buffer.getPendingCount(SESSION_ID)).toBe(110 - sent + session.claimedMessageIds.length);
  });

  it('confirms only the batch the model answered, never what was enqueued behind it', async () => {
    for (let i = 0; i < 3; i++) buffer.enqueue(SESSION_ID, observation(i));
    const gen = start();
    await gen.next();
    await answer();

    const batch = await gen.next();
    expect(batch.message.content.match(/step \d/g)).toEqual(['step 0', 'step 1', 'step 2']);

    // Arrives while that turn is being answered.
    for (let i = 3; i < 6; i++) buffer.enqueue(SESSION_ID, observation(i));
    expect(await gen.next()).toBe('stalled');
    expect(session.claimedMessageIds.length).toBe(3);

    await answer();
    expect(buffer.getPendingCount(SESSION_ID)).toBe(3);

    const next = await gen.next();
    expect(next.message.content.match(/step \d/g)).toEqual(['step 3', 'step 4', 'step 5']);
  });

  it('sends a summary as its own turn', async () => {
    buffer.enqueue(SESSION_ID, observation(0));
    buffer.enqueue(SESSION_ID, { type: 'summarize', last_assistant_message: 'done' });
    buffer.enqueue(SESSION_ID, observation(1));
    const gen = start();
    await gen.next();

    await answer();
    expect((await gen.next()).message.content).toContain('step 0');
    expect(session.claimedMessageIds.length).toBe(1);

    await answer();
    const summary = await gen.next();
    expect(summary.message.content).not.toMatch(/step \d/);
    expect(session.lastGeneratorSource).toBe('summarize');

    await answer();
    expect((await gen.next()).message.content).toContain('step 1');
  });

  it('keeps one agent and one prompt per batch', async () => {
    buffer.enqueue(SESSION_ID, observation(0));
    buffer.enqueue(SESSION_ID, observation(1, { agentId: 'sub-1' }));
    buffer.enqueue(SESSION_ID, observation(2, { agentId: 'sub-1', prompt_number: 3 }));
    const gen = start();
    await gen.next();

    for (const expected of ['step 0', 'step 1', 'step 2']) {
      await answer();
      const batch = await gen.next();
      expect(batch.message.content.match(/step \d/g)).toEqual([expected]);
    }
    expect(session.pendingAgentId).toBe('sub-1');
    expect(session.lastPromptNumber).toBe(3);
  });

  it('hands a turn that never finishes back to the buffer and stops the generator', async () => {
    (provider as any).turnTimeoutMs = 20;
    buffer.enqueue(SESSION_ID, observation(0));
    const gen = start();
    await gen.next();
    await answer();
    await gen.next();
    expect(session.claimedMessageIds.length).toBe(1);

    expect(await gen.next()).toBe('done');

    expect(session.abortReason).toBe('transport:turn_timeout');
    expect(session.claimedMessageIds).toEqual([]);
    expect(buffer.peekNextUnclaimed(SESSION_ID)?.tool_input).toEqual({ command: 'step 0' });
  });

  it('stops waiting when the session is aborted', async () => {
    const gen = start();
    await gen.next();
    session.abortController.abort();

    expect(await gen.next()).toBe('done');
  });
});
