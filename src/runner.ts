import { ClaudeRunner as PresetClaudeRunner, type ClaudeRunnerOptions } from '@agentchatme/agent-core/presets'
import { claudeUserStatePathFor, identityHomeFor, invocation, runWorkdirFor } from './host.js'

// ─── One headless run of Claude Code, as THIS integration's agent ───────────
//
// How a `claude -p` run is started — its flags per run profile, its
// environment, how Claude Code is found and its sign-in told — is the Claude
// Code preset in @agentchatme/agent-core/presets, shared with the
// `agentchat listen --preset claude-code` listener so the two can never
// drift. What is this integration's own is which agent the runs act as and
// what they must not read: the hosted tools reach the run through the
// user-scope MCP server the installer registered (`mcp__agentchat__*`), and
// every run's file tools are denied this integration's identity home and
// `~/.claude.json`, where that server's key lives.

export { buildClaudeEnv, claudeIsLoggedIn, deniedAncestorOf, inspectClaudeRuntime, PARENT_ENV_KEYS } from '@agentchatme/agent-core/presets'

/**
 * The key store, denied to every run's file tools: the identity home
 * (credentials, status, logs) and ~/.claude.json, where the user-scope MCP
 * entry carries the key. A run judging peer text must not be able to read
 * either and send it. ONE list, so what the runs are denied and what the
 * workdir is checked against cannot drift apart.
 */
export function denyReadPathsFor(configDirOverride: string | undefined): string[] {
  return [identityHomeFor(configDirOverride), claudeUserStatePathFor(configDirOverride)]
}

export type IntegrationRunnerOptions = Omit<ClaudeRunnerOptions, 'denyReadPaths' | 'mcpConfigPath' | 'workdirAdvice'>

/** The preset's runner with this integration's deny list, and its user-scope MCP server (no `--mcp-config`). */
export class ClaudeRunner extends PresetClaudeRunner {
  constructor(options: IntegrationRunnerOptions) {
    super({
      ...options,
      denyReadPaths: denyReadPathsFor(options.configDir),
      workdirAdvice: `Point AGENTCHAT_RUN_CWD outside it, or unset it for the default ${runWorkdirFor(options.configDir)}, then re-run \`${invocation()} daemon install\``,
    })
  }
}
