import * as os from 'node:os'
import * as path from 'node:path'
import { MANUAL_FILENAME, MANUAL_SKILL_NAME, serviceLabelFor } from '@agentchatme/agent-core'

// ─── The only file in this repo that knows a host exists ────────────────────
//
// Everything host-specific about the Claude Code doorbell is here. The rest of
// the package reads these; @agentchatme/agent-core knows none of them.
//
// There is deliberately no `--platform` flag and no host detection. This
// binary acts on the Claude Code agent because that is what it IS, not because
// of a runtime argument — so "acted on the wrong agent" is not a bug that can
// be written here.

/** Claude Code's supported relocation knob. Unset is NOT the same as `~/.claude`. */
export function claudeConfigOverride(): string | undefined {
  const override = process.env['CLAUDE_CONFIG_DIR']
  return override !== undefined && override.trim().length > 0 ? path.resolve(override) : undefined
}

export function claudeHome(): string {
  return claudeConfigOverride() ?? path.join(os.homedir(), '.claude')
}

/** THE identity home for this agent. Passed into every agent-core call. */
export function identityHome(): string {
  return identityHomeFor(claudeConfigOverride())
}

/** The identity home for a given config dir (the daemon's runner carries it as an option). */
export function identityHomeFor(configDirOverride: string | undefined): string {
  return path.join(configDirOverride ?? path.join(os.homedir(), '.claude'), 'agentchat')
}

/** Claude Code's always-loaded user instruction file: the identity line goes here. */
export function anchorFile(): string {
  return path.join(claudeHome(), 'CLAUDE.md')
}

/**
 * Where Claude Code keeps user-scoped MCP servers: `~/.claude.json`, or
 * `$CLAUDE_CONFIG_DIR/.claude.json` when the directory is relocated
 * (code.claude.com/docs/en/mcp.md, "User scope").
 */
export function claudeUserStatePath(): string {
  return claudeUserStatePathFor(claudeConfigOverride())
}

export function claudeUserStatePathFor(configDirOverride: string | undefined): string {
  return configDirOverride !== undefined ? path.join(configDirOverride, '.claude.json') : path.join(os.homedir(), '.claude.json')
}

export function settingsPath(): string {
  return path.join(claudeHome(), 'settings.json')
}

/** Personal skills: `~/.claude/skills/<name>/SKILL.md` (code.claude.com/docs/en/skills.md). */
export function skillsDir(): string {
  return path.join(claudeHome(), 'skills')
}

export function skillDir(): string {
  return path.join(skillsDir(), MANUAL_SKILL_NAME)
}

/** The bundled manual, as the `agentchat` skill. */
export function skillPath(): string {
  return path.join(skillDir(), MANUAL_FILENAME)
}

export const LABEL = 'Claude Code'

/** The service label of the default config (`~/.claude`) — the label every install before per-home labels used. */
export const SERVICE_BASE_LABEL = 'agentchatd-claude-code'

/**
 * The doorbell service's label for THIS config. `launchctl` / `systemctl
 * --user` address the user's domain whatever HOME or CLAUDE_CONFIG_DIR say, so
 * a relocated config dir gets its own label (`agentchatd-claude-code-<8 hex>`)
 * and can never address the default config's service; `~/.claude` keeps the
 * plain label, so existing installs keep working.
 */
export function serviceLabel(): string {
  return serviceLabelFor(SERVICE_BASE_LABEL, identityHome(), identityHomeFor(undefined))
}

/** Labels this config's service replaces: a relocated config was installed under the plain label before. */
export function supersededServiceLabels(): string[] {
  return serviceLabel() === SERVICE_BASE_LABEL ? [] : [SERVICE_BASE_LABEL]
}

/**
 * The user-scope MCP server name. Changing it changes every tool name the
 * model sees (`mcp__agentchat__agentchat_inbox`) — keep in lockstep with the
 * prompts the daemon builds.
 */
export const MCP_SERVER_NAME = 'agentchat'

/** Exactly what a user types to reach this integration. */
export function invocation(): string {
  const override = process.env['AGENTCHAT_CLI_NAME']?.trim()
  if (override !== undefined && override.length > 0) return override
  return 'npx -y @agentchatme/claude-code'
}

export function hostCopy(): { invoke: string; label: string } {
  return { invoke: invocation(), label: LABEL }
}

/**
 * Env the service must see. A launchd/systemd service does NOT inherit the
 * login shell, so the doorbell's switches are captured at install time:
 * `AGENTCHAT_RUN_PROFILE=work npx -y @agentchatme/claude-code daemon install`.
 */
export function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const configDir = claudeConfigOverride()
  if (configDir !== undefined) env['CLAUDE_CONFIG_DIR'] = configDir
  for (const key of ['AGENTCHAT_RUN_PROFILE', 'AGENTCHAT_DOORBELL', 'AGENTCHAT_RUN_BUDGET_MS', 'AGENTCHAT_RUN_CWD', 'AGENTCHAT_RUN_MAX_BUDGET_USD', 'AGENTCHAT_API_BASE']) {
    const value = process.env[key]?.trim()
    if (value !== undefined && value.length > 0) env[key] = value
  }
  return env
}
