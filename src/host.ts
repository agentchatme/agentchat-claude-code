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
// Honour Claude Code's supported relocation knob. The direct user-scoped MCP
// entry invokes this bundle as a small proxy, so the CLI, hooks and MCP
// subprocess all resolve exactly the same identity home.
export function claudeConfigOverride(): string | undefined {
  const override = process.env['CLAUDE_CONFIG_DIR']
  return override !== undefined && override.trim().length > 0
    ? path.resolve(override)
    : undefined
}

export function claudeHome(): string {
  return claudeConfigOverride() ?? path.join(os.homedir(), '.claude')
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
 * Exactly what a user types to reach this integration. Hooks use a durable
 * absolute copy, but every human-facing repair/setup command stays runnable on
 * a fresh machine without a global install.
 */
export function invocation(): string {
  const override = process.env['AGENTCHAT_CLI_NAME']?.trim()
  if (override !== undefined && override.length > 0) return override
  return 'npx -y @agentchatme/claude-code'
}

export function hostCopy(): { invoke: string; label: string } {
  return { invoke: invocation(), label: LABEL }
}

export function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const configDir = claudeConfigOverride()
  if (configDir !== undefined) env['CLAUDE_CONFIG_DIR'] = configDir
  return env
}
