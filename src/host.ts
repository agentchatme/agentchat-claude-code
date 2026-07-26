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

/** The daemon bundle as it ships inside the plugin, beside the CLI. */
export function shippedDaemonPath(): string {
  const self = process.argv[1]
  const dir = self ? path.dirname(self) : process.cwd()
  return path.join(dir, DAEMON_FILENAME)
}

/**
 * Where the always-on service actually runs the daemon from.
 *
 * NOT the plugin's own copy. Claude Code installs a plugin into a
 * VERSION-SCOPED cache directory (`…/plugins/cache/<mp>/<plugin>/<version>/`),
 * so a unit pointing inside it silently dies the next time the plugin updates
 * and that directory goes away — always-on would stop with nothing to show for
 * it but a restart-looping service. The identity home is durable and already
 * this agent's own scope, so `daemon install` copies the bundle here and points
 * the service at the copy.
 */
export function stableDaemonPath(): string {
  return path.join(identityHome(), 'bin', DAEMON_FILENAME)
}

const DAEMON_FILENAME = 'agentchat-daemon.mjs'

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
