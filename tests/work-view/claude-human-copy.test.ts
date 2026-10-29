import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeHumanCopyProvider } from '../../src/services/work-view/claude-human-copy.js';
import { HUMAN_COPY_SYSTEM_PROMPT } from '../../src/services/work-view/human-copy-worker.mjs';
import { configuredHumanCopyProvider } from '../../src/services/worker/http/routes/WorkViewRoutes.js';

// husni fork: CLAUDE_MEM_HUMAN_COPY_PROVIDER=claude writes My Work's request copy through the observer's Claude Code.

const copy = { title: 'Ship the release cards', summary: 'Cards now show each release.', next: '', stage: 'Building', workstreams: [] };

/** A query() that records what it was asked and answers with the given messages. */
function fakeQuery(messages: unknown[]) {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const impl = ((params: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(params);
    return (async function* () { yield* messages; })();
  }) as unknown as typeof query;
  return { impl, calls };
}

const result = (fields: Record<string, unknown>) => ({ type: 'result', session_id: 'session-1', usage: { input_tokens: 10, output_tokens: 5 }, ...fields });

function provider(messages: unknown[]) {
  const fake = fakeQuery(messages);
  const run = claudeHumanCopyProvider({ model: 'gpt-6-luna', queryImpl: fake.impl, claudePath: () => '/usr/local/bin/claude', env: async () => ({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' }) });
  return { run, calls: fake.calls };
}

describe('the Claude human copy provider', () => {
  it('asks one locked-down turn on the observer model with the summary instructions, and parses the answer', async () => {
    const { run, calls } = provider([result({ subtype: 'success', is_error: false, result: JSON.stringify(copy) })]);

    const answer = await run({ id: 'request-1' });

    expect(answer).toEqual({ output: copy, usage: { input_tokens: 10, output_tokens: 5 }, model: 'gpt-6-luna', responseId: 'session-1', error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe(JSON.stringify({ id: 'request-1' }));
    expect(calls[0]!.options).toMatchObject({
      model: 'gpt-6-luna', systemPrompt: HUMAN_COPY_SYSTEM_PROMPT, maxTurns: 1,
      pathToClaudeCodeExecutable: '/usr/local/bin/claude', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
      tools: [], allowedTools: [], permissionMode: 'dontAsk', settingSources: [], mcpServers: {}, strictMcpConfig: true,
    });
  });

  it('reads an answer the model fenced as a JSON code block', async () => {
    const { run } = provider([result({ subtype: 'success', is_error: false, result: `\`\`\`json\n${JSON.stringify(copy)}\n\`\`\`` })]);

    expect((await run({})).output).toEqual(copy);
  });

  it('reports an unsuccessful run, an empty answer and an answer that is not JSON', async () => {
    expect((await provider([result({ subtype: 'error_max_turns', is_error: true })]).run({})).error).toBe('Summary agent ended with error_max_turns.');
    expect((await provider([result({ subtype: 'success', is_error: false, result: '' })]).run({})).error).toBe('No answer text.');
    expect((await provider([result({ subtype: 'success', is_error: false, result: 'Here is the copy.' })]).run({})).error).toBe('Invalid summary JSON.');
  });
});

describe('configuredHumanCopyProvider', () => {
  function withSettings(settings: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'human-copy-provider-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify(settings));
    try { return configuredHumanCopyProvider(path); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('writes copy through Claude Code only when the setting asks for it', () => {
    expect(typeof withSettings({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_HUMAN_COPY_PROVIDER: 'claude' })).toBe('function');
    expect(withSettings({ CLAUDE_MEM_PROVIDER: 'claude' })).toBeNull();
  });
});
