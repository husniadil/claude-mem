/**
 * husni fork: My Work's request copy written by the observer's own Claude Code
 * (CLAUDE_MEM_HUMAN_COPY_PROVIDER=claude). Upstream writes it only through an
 * OpenRouter key, so a host whose observer runs on Claude Code, here behind a
 * provider daemon, kept every card on its raw agent lines with a spinner that
 * never stopped. One locked-down query per request: no tools, no settings or
 * MCP inheritance, one turn, on the observer's model and endpoint.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildHardenedSdkOptions } from '../../sdk/hardened-options.js';
import { buildIsolatedEnvWithFreshOAuth } from '../../shared/EnvManager.js';
import { findClaudeExecutable } from '../../shared/find-claude-executable.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { HUMAN_COPY_SYSTEM_PROMPT } from './human-copy-worker.mjs';

const SUMMARY_TIMEOUT_MS = 120_000;

export interface ClaudeHumanCopyOptions {
  model: string;
  queryImpl?: typeof query;
  claudePath?: () => string;
  env?: () => Promise<NodeJS.ProcessEnv>;
  timeoutMs?: number;
}

/** The answer's JSON object, also when the model fenced it as a code block. */
function answerJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

export function claudeHumanCopyProvider({
  model,
  queryImpl = query,
  claudePath = () => findClaudeExecutable('WORKER'),
  env = async () => sanitizeEnv(await buildIsolatedEnvWithFreshOAuth()),
  timeoutMs = SUMMARY_TIMEOUT_MS,
}: ClaudeHumanCopyOptions) {
  return async (input: unknown): Promise<Record<string, unknown>> => {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const options = {
        ...buildHardenedSdkOptions({
          source: 'HumanCopy',
          model,
          env: await env(),
          pathToClaudeCodeExecutable: claudePath(),
          abortController,
        }),
        systemPrompt: HUMAN_COPY_SYSTEM_PROMPT,
        maxTurns: 1,
      };
      let text = '';
      let usage: unknown = null;
      let responseId: string | null = null;
      let failure: string | null = null;
      for await (const message of queryImpl({ prompt: JSON.stringify(input), options })) {
        if (message.session_id) responseId = message.session_id;
        if (message.type !== 'result') continue;
        usage = message.usage ?? null;
        if (message.subtype === 'success' && !message.is_error) text = message.result;
        else failure = `Summary agent ended with ${message.subtype}.`;
      }
      const json = answerJson(text);
      let output: unknown = null;
      try { if (json) output = JSON.parse(json); } catch { /* reported below */ }
      return {
        output, usage, model, responseId,
        error: failure ?? (!json ? 'No answer text.' : output === null ? 'Invalid summary JSON.' : null),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
