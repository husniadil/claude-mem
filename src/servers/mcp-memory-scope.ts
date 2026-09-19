// What the MCP server lets a session read from memory, per session.
//
// The worker keeps every project's memory in one database and answers any
// project it is asked for. A session can be held to its own project
// (CLAUDE_MEM_SEARCH_SCOPE=project): every memory tool is then called with that
// project, and the tools that cannot be held to one are not offered. The hold
// is here, in the MCP server, so it binds the model calling the tools. It does
// not bind a process that reaches the worker's HTTP port itself.
//
// search() without dateStart only looks back CLAUDE_MEM_SEARCH_RECENCY_DAYS
// (0: no limit). The MCP server fills dateStart in itself, so the window it
// describes to the model is the one it uses.

import { getProjectContext } from '../utils/project-name.js';
import { logger } from '../utils/logger.js';

export type SearchScope = 'all' | 'project';

export interface MemoryPolicy {
  scope: SearchScope;
  project: string;
  recencyDays: number;
}

// The tools a project-scoped session keeps. Each memory tool here passes the
// project on to the worker, which filters by it. The corpus tools read corpora
// built from any project, and the observation_* tools write as well, so they go.
const PROJECT_SCOPED_TOOLS = new Set([
  'important_workflow',
  'search',
  'timeline',
  'get_observations',
  'get_tool_uses',
  'session_start_context',
  'smart_search',
  'smart_unfold',
  'smart_outline',
]);

// The tools that read memory and take a project.
const MEMORY_TOOLS = new Set(['search', 'timeline', 'get_observations', 'get_tool_uses', 'session_start_context']);

const DAY_MS = 24 * 60 * 60 * 1000;

export function memoryPolicy(
  settings: { CLAUDE_MEM_SEARCH_SCOPE: string; CLAUDE_MEM_SEARCH_RECENCY_DAYS: string },
  cwd: string,
): MemoryPolicy {
  const scope = settings.CLAUDE_MEM_SEARCH_SCOPE.trim().toLowerCase();
  if (scope !== 'all' && scope !== 'project') {
    throw new Error(`CLAUDE_MEM_SEARCH_SCOPE must be "all" or "project", not "${settings.CLAUDE_MEM_SEARCH_SCOPE}"`);
  }
  const days = Number(settings.CLAUDE_MEM_SEARCH_RECENCY_DAYS.trim());
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`CLAUDE_MEM_SEARCH_RECENCY_DAYS must be a whole number of days, 0 for no limit, not "${settings.CLAUDE_MEM_SEARCH_RECENCY_DAYS}"`);
  }
  const policy: MemoryPolicy = { scope, project: getProjectContext(cwd).primary, recencyDays: days };
  logger.info('SYSTEM', 'MCP memory policy', { scope: policy.scope, project: policy.project, recencyDays: policy.recencyDays });
  return policy;
}

export function isOffered(policy: MemoryPolicy, toolName: string): boolean {
  return policy.scope === 'all' || PROJECT_SCOPED_TOOLS.has(toolName);
}

function windowText(policy: MemoryPolicy): string {
  return policy.recencyDays === 0
    ? 'Without dateStart it searches all of memory.'
    : `Without dateStart it searches only the last ${policy.recencyDays} days; pass dateStart for anything older.`;
}

function scopeText(policy: MemoryPolicy): string {
  return `Memory is limited to this session's project, "${policy.project}".`;
}

// The tool as this session is told about it: the window in search's own
// description, and in a project-scoped session no project parameter to set.
export function describeTool<T extends { name: string; description: string; inputSchema: any }>(
  policy: MemoryPolicy,
  tool: T,
): T {
  let description = tool.description;
  let inputSchema = tool.inputSchema;
  if (tool.name === 'search') {
    description = `${description}. ${windowText(policy)}`;
  }
  if (policy.scope === 'project' && MEMORY_TOOLS.has(tool.name)) {
    const { project: _project, projects: _projects, ...properties } = inputSchema.properties;
    inputSchema = { ...inputSchema, properties };
    description = `${description} ${scopeText(policy)}`;
  }
  return { ...tool, description, inputSchema };
}

// The arguments a tool call goes to the worker with. A project the model asked
// for is replaced, never merged, in a project-scoped session.
export function scopeArgs(
  policy: MemoryPolicy,
  toolName: string,
  args: Record<string, any>,
  now: number = Date.now(),
): Record<string, any> {
  const out = { ...args };
  if (policy.scope === 'project' && MEMORY_TOOLS.has(toolName)) {
    delete out.projects;
    out.project = policy.project;
  }
  if (toolName === 'search' && out.dateStart === undefined && out.date_start === undefined && out.date_from === undefined) {
    // An epoch of 0 is read by the worker as no lower bound.
    out.dateStart = new Date(policy.recencyDays === 0 ? 0 : now - policy.recencyDays * DAY_MS).toISOString();
  }
  return out;
}
