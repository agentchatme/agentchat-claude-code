import * as os from 'node:os'
import * as path from 'node:path'

// ─── The only file in this repo that knows a host exists ────────────────────
//
// Everything host-specific about the Claude Code integration is here. The rest
// of the package reads these; @agentchatme/agent-core knows none of them.
//
// There is deliberately no `--platform` flag and no host detection. This
// binary acts on the Claude Code agent because that is what it IS, not because
// of a runtime argument — so "acted on the wrong agent" is not a bug that can
// be written here.
//
// Pinned to os.homedir()/.claude, NOT CLAUDE_CONFIG_DIR: the committed
// plugin `.mcp.json` sets the MCP server's home to `${HOME}/.claude/agentchat`
// and Claude Code does NOT substitute an unset CLAUDE_CONFIG_DIR — verified
// empirically 2026-07-23 (`${CLAUDE_CONFIG_DIR}` stayed literal; the nested
// `${VAR:-default}` form mangled the path). Both sides must resolve the same
// folder, so this is the one that agrees with the shipped config.
export function claudeHome(): string {
  return path.join(os.homedir(), '.claude')
}

/** THE identity home for this agent. Passed into every agent-core call. */
export function identityHome(): string {
  return path.join(claudeHome(), 'agentchat')
}

/** Claude Code's always-loaded instruction file. */
export function anchorFile(): string {
  return path.join(claudeHome(), 'CLAUDE.md')
}

export const LABEL = 'Claude Code'
export const SERVICE_LABEL = 'agentchatd-claude-code'

/**
 * Exactly what a user types to reach this integration. The plugin ships its
 * own bundle, so hooks and the first-run offer invoke an absolute path — the
 * one invocation guaranteed to work on a fresh machine, since nothing put
 * `agentchat` on PATH.
 */
export function invocation(): string {
  const override = process.env['AGENTCHAT_CLI_NAME']?.trim()
  if (override !== undefined && override.length > 0) return override
  const self = process.argv[1]
  return self ? `node "${self}"` : 'agentchat-claude-code'
}

export function hostCopy(): { invoke: string; label: string } {
  return { invoke: invocation(), label: LABEL }
}

export function serviceEnv(): Record<string, string> {
  return {}
}
