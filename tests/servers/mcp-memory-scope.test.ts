import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryPolicy, isOffered, describeTool, scopeArgs } from '../../src/servers/mcp-memory-scope.js';

// A directory outside any git repository names the project by its basename.
const dir = join(mkdtempSync(join(tmpdir(), 'scope-')), 'husni');
const NOW = Date.parse('2026-09-19T00:00:00.000Z');

const policy = (scope: string, days = '90') =>
  memoryPolicy({ CLAUDE_MEM_SEARCH_SCOPE: scope, CLAUDE_MEM_SEARCH_RECENCY_DAYS: days }, dir);

const search = {
  name: 'search',
  description: 'Step 1: Search memory',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' } } },
};

describe('MCP memory scope', () => {
  it('names the project the way the hooks record it', () => {
    expect(policy('project').project).toBe('husni');
  });

  it('refuses a setting it cannot read rather than widening access', () => {
    expect(() => policy('everything')).toThrow('CLAUDE_MEM_SEARCH_SCOPE');
    expect(() => policy('all', '-1')).toThrow('CLAUDE_MEM_SEARCH_RECENCY_DAYS');
    expect(() => policy('all', 'thirty')).toThrow('CLAUDE_MEM_SEARCH_RECENCY_DAYS');
  });

  it('holds every memory tool to the project, whatever the model asked for', () => {
    const p = policy('project');
    for (const tool of ['search', 'timeline', 'get_observations', 'get_tool_uses']) {
      expect(scopeArgs(p, tool, { project: 'agamemnon', ids: [1] }, NOW).project).toBe('husni');
    }
    const context = scopeArgs(p, 'session_start_context', { projects: ['agamemnon', 'logram'] }, NOW);
    expect(context.projects).toBeUndefined();
    expect(context.project).toBe('husni');
  });

  it('leaves the project alone with scope all', () => {
    expect(scopeArgs(policy('all'), 'search', { project: 'logram' }, NOW).project).toBe('logram');
    expect(scopeArgs(policy('all'), 'search', {}, NOW).project).toBeUndefined();
  });

  it('offers a project-scoped session no tool that reads other projects', () => {
    const p = policy('project');
    expect(isOffered(p, 'search')).toBe(true);
    expect(isOffered(p, 'smart_search')).toBe(true);
    for (const tool of ['build_corpus', 'query_corpus', 'list_corpora', 'observation_search', 'observation_add']) {
      expect(isOffered(p, tool)).toBe(false);
      expect(isOffered(policy('all'), tool)).toBe(true);
    }
  });

  it('fills in the window it describes when search has no dateStart', () => {
    expect(scopeArgs(policy('all', '30'), 'search', {}, NOW).dateStart).toBe('2026-08-20T00:00:00.000Z');
    expect(scopeArgs(policy('all', '0'), 'search', {}, NOW).dateStart).toBe('1970-01-01T00:00:00.000Z');
    expect(scopeArgs(policy('all', '30'), 'search', { dateStart: '2026-05-01' }, NOW).dateStart).toBe('2026-05-01');
    expect(scopeArgs(policy('all', '30'), 'search', { date_from: '2026-05-01' }, NOW).dateStart).toBeUndefined();
    expect(scopeArgs(policy('all', '30'), 'timeline', { anchor: 1 }, NOW).dateStart).toBeUndefined();
  });

  it('tells the model the window and the scope it gets', () => {
    expect(describeTool(policy('all', '30'), search).description).toContain('only the last 30 days; pass dateStart');
    expect(describeTool(policy('all', '0'), search).description).toContain('searches all of memory');
    const scoped = describeTool(policy('project'), search);
    expect(scoped.description).toContain('limited to this session\'s project, "husni"');
    expect(Object.keys(scoped.inputSchema.properties)).toEqual(['query']);
    expect(Object.keys(describeTool(policy('all'), search).inputSchema.properties)).toEqual(['query', 'project']);
  });

  it('is applied on both the list and the call paths of the server', async () => {
    const src = await Bun.file(join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts')).text();
    expect(src).toContain('.filter(tool => isOffered(memory, tool.name))');
    expect(src).toContain('!isOffered(memory, tool.name)');
    expect(src).toContain('tool.handler(scopeArgs(memory, tool.name,');
  });
});
