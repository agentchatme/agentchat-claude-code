import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

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
// Honour Claude Code's supported relocation knob. The plugin MCP config invokes
// this bundle as a small proxy, so both the CLI/hooks and the MCP subprocess
// resolve the fallback in executable code rather than relying on unsupported
// `${VAR:-default}` interpolation inside JSON.
export function claudeHome(): string {
  const override = process.env['CLAUDE_CONFIG_DIR']
  if (override !== undefined && override.trim().length > 0) return path.resolve(override)
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
  // Anchored to THIS MODULE, not to process.argv[1]. argv[1] is whatever was
  // invoked — a bin shim, a symlink, a wrapper — and the daemon is shipped
  // beside the bundle, not beside its caller. The Codex integration had the
  // same bug and it made `daemon install` fail for every npx user.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), DAEMON_FILENAME)
}

/** The plugin-owned MCP declaration, from either a real plugin cache or this
 * repository's build layout. */
export function pluginMcpConfigPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const installed = path.resolve(moduleDir, '..', '.mcp.json')
  if (fs.existsSync(installed)) return installed
  return path.resolve(moduleDir, '..', 'plugin', '.mcp.json')
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
  const env: Record<string, string> = {}
  const configDir = process.env['CLAUDE_CONFIG_DIR']
  if (configDir !== undefined && configDir.trim().length > 0) {
    env['CLAUDE_CONFIG_DIR'] = path.resolve(configDir)
  }
  return env
}
