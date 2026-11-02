import type { RunProfile } from '@agentchatme/agent-core'
import { MCP_SERVER_NAME } from './host.js'

// ─── Run profiles → Claude Code flags ───────────────────────────────────────
//
// What a headless run may do is the operator's decision (`AGENTCHAT_RUN_PROFILE`),
// mapped here to Claude Code's real flags. Verified against `claude --help`
// (2.1.316) and code.claude.com/docs/en/cli-reference.md, headless.md,
// permission-modes.md:
//
//   --permission-prompts none   anything that would prompt is denied, never
//                               waited on; the permission mode and allow rules
//                               still decide every call first (v2.1.259+).
//   --tools <list>              restricts the BUILT-IN tool set; does not affect
//                               MCP tools. Listing Glob/Grep explicitly provides
//                               the dedicated search tools.
//   --allowedTools <rules>      pre-approves. `mcp__agentchat__*` is the whole
//                               hosted server; `Bash` pre-approves every shell
//                               command (dropped as a broad rule only in auto mode).
//   --disallowedTools <rules>   denies. Deny rules win over allow rules, and a
//                               `Read(<path>)` rule covers every built-in tool
//                               that reads files (Read, Grep, Glob — docs:
//                               permissions.md "Read & Edit"). Used to keep a
//                               run's file tools off the key store: the
//                               identity home and ~/.claude.json. `//` prefixes
//                               an absolute path in rule syntax.
//   --permission-mode default   Manual: reads need no approval, everything else
//                               prompts (and is therefore denied here).
//   --permission-mode acceptEdits  file edits and common filesystem commands in
//                               the working directory need no approval.
//   --dangerously-skip-permissions  = bypassPermissions.
//
// Whatever the profile, every AgentChat hosted tool is pre-approved: the run
// exists to read the tray and decide or send through them.

export const AGENTCHAT_TOOL_ALLOW = `mcp__${MCP_SERVER_NAME}__*`

/** Built-in tools an `answer` run keeps: read-only files plus the web. */
export const ANSWER_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] as const

/** Built-in tools a `work` run additionally pre-approves. */
export const WORK_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

export function claudeProfileArgs(profile: RunProfile): string[] {
  switch (profile) {
    case 'answer':
      return [
        '--permission-mode',
        'default',
        '--permission-prompts',
        'none',
        '--tools',
        ANSWER_TOOLS.join(','),
        '--allowedTools',
        [AGENTCHAT_TOOL_ALLOW, ...ANSWER_TOOLS].join(','),
      ]
    case 'work':
      return [
        '--permission-mode',
        'acceptEdits',
        '--permission-prompts',
        'none',
        '--allowedTools',
        [AGENTCHAT_TOOL_ALLOW, ...ANSWER_TOOLS, ...WORK_TOOLS].join(','),
      ]
    case 'full':
      return ['--dangerously-skip-permissions', '--permission-prompts', 'none', '--allowedTools', AGENTCHAT_TOOL_ALLOW]
  }
}

export interface ClaudeRunArgOptions {
  /** `AGENTCHAT_RUN_MAX_BUDGET_USD`: stop the run once estimated spend reaches this (print mode only). */
  readonly maxBudgetUsd?: string | undefined
  /**
   * Absolute paths the run's file tools may not read (a directory covers its
   * tree). Rendered as `Read(//<path>)` / `Read(//<dir>/**)` deny rules. A
   * prompt-injected run could otherwise read the key and send it; the wake
   * text should not be the only guard. POSIX paths only — on Windows the
   * rule syntax for drive paths is undocumented, so nothing is rendered.
   */
  readonly denyReadPaths?: readonly string[] | undefined
}

/** `/Users/x/.claude/agentchat` → `Read(//Users/x/.claude/agentchat/**)` and `Read(//Users/x/.claude/agentchat)`. */
export function readDenyRules(paths: readonly string[]): string[] {
  if (process.platform === 'win32') return []
  const rules: string[] = []
  for (const raw of paths) {
    if (!raw.startsWith('/') || raw.includes(',') || raw.includes(' ')) continue // not expressible in a comma/space list
    const clean = raw.replace(/\/+$/, '')
    rules.push(`Read(/${clean})`, `Read(/${clean}/**)`)
  }
  return rules
}

/**
 * The full argument list for one headless run. The prompt goes on STDIN, not
 * as a positional: the variadic `--allowedTools` would otherwise swallow a
 * trailing positional (verified on 2.1.220; `cat file | claude -p` is the
 * documented piped form).
 */
export function claudeRunArgs(profile: RunProfile, options: ClaudeRunArgOptions = {}): string[] {
  const budget = options.maxBudgetUsd?.trim()
  const deny = readDenyRules(options.denyReadPaths ?? [])
  return [
    '-p',
    '--output-format',
    'text',
    // A doorbell run is not a conversation to resume; keep it out of the
    // user's session list and off the disk.
    '--no-session-persistence',
    ...(budget !== undefined && /^\d+(\.\d+)?$/.test(budget) ? ['--max-budget-usd', budget] : []),
    ...claudeProfileArgs(profile),
    // Last: the option is variadic and the prompt arrives on stdin, so there
    // is no positional for it to swallow.
    ...(deny.length > 0 ? ['--disallowedTools', deny.join(',')] : []),
  ]
}
