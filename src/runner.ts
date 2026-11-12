import * as fs from 'node:fs'
import * as path from 'node:path'
import { manualPointer, resolveIdentity, runProfileWarning, type RunProfile } from '@agentchatme/agent-core'
import { ClaudeRunner as PresetClaudeRunner, claudeMcpConfigPath, type ClaudeRunnerOptions } from '@agentchatme/agent-core/presets'
import { claudeUserStatePathFor, identityHomeFor, invocation, runWorkdirFor } from './host.js'
import { VERSION } from './version.js'

// ─── One headless run of Claude Code, as THIS integration's agent ───────────
//
// How a `claude -p` run is started — its flags per run profile, its
// environment, how Claude Code is found and its sign-in told — is the Claude
// Code preset in @agentchatme/agent-core/presets, shared with the
// `agentchat listen --preset claude-code` listener so the two can never
// drift. What is this integration's own is which agent the runs act as and
// what they must not read:
//
//   * `work` and `full` runs reach the hosted tools through the user-scope MCP
//     server the installer registered (`mcp__agentchat__*`), beside every
//     other MCP server the user has, as in any session.
//   * An `answer` run (the default, started by any peer's message) loads the
//     AgentChat server ALONE: the preset writes it a tool config of its own
//     for that run (`<identity home>/presets/claude-code.mcp.<run id>.json`,
//     owner-only, this agent's key read at that moment), passes it with
//     `--mcp-config … --strict-mcp-config`, and removes it when the run ends.
//     Its identity line comes from the served texts the same way (a
//     `….identity.md` file beside it, `--append-system-prompt-file`): an
//     answer run loads no CLAUDE.md.
//   * Every run's file tools are denied this integration's identity home and
//     `~/.claude.json`, where the key lives.

export { buildClaudeEnv, claudeIsLoggedIn, deniedAncestorOf, inspectClaudeRuntime, PARENT_ENV_KEYS } from '@agentchatme/agent-core/presets'

/**
 * The key store, denied to every run's file tools: the identity home
 * (credentials, status, logs, an answer run's own tool config) and
 * ~/.claude.json, where the user-scope MCP entry carries the key. A run
 * judging peer text must not be able to read either and send it. ONE list, so
 * what the runs are denied and what the workdir is checked against cannot
 * drift apart.
 */
export function denyReadPathsFor(configDirOverride: string | undefined): string[] {
  return [identityHomeFor(configDirOverride), claudeUserStatePathFor(configDirOverride)]
}

/**
 * Where an answer run's AgentChat-only tool config is written, one file per run
 * beside this name (`claude-code.mcp.<run id>.json`), inside the identity home
 * every run is denied. The preset's own name for it (`claudeMcpConfigPath`).
 */
export function answerToolConfigFor(identityHome: string): string {
  return claudeMcpConfigPath(identityHome)
}

export interface IntegrationRunnerOptions extends Omit<ClaudeRunnerOptions, 'denyReadPaths' | 'mcpConfigPath' | 'workdirAdvice' | 'answerMcp'> {
  /**
   * The API base of the agent the runs act as: an answer run's tool config
   * points the hosted server there. The daemon passes its identity's.
   */
  readonly apiBase: string
  /**
   * The identity home whose agent the runs act as: an answer run's tool config
   * is written inside it and carries the key it holds at that moment. Default:
   * this config's (`identityHomeFor(configDir)`), what the installed service
   * serves. Denied to every run, like the default one.
   */
  readonly identityHome?: string
  /**
   * The handle of the agent the runner was built for (the daemon passes its
   * identity's). An answer run's key is read from the identity file when it
   * starts, so a rotated key is followed; a file that by then names another
   * agent, or another API base, gives no key (no run): the daemon is about to
   * build a runner for that one, and a run must not send one agent's key to
   * another's server.
   */
  readonly handle?: string
}

/**
 * The key an answer run is given: the identity home's, as it is now — when it
 * is still the agent (handle, from the file) and the server (`apiBase`) the
 * runner was built for. Null otherwise, and when signed out.
 */
export function answerRunKey(identityHome: string, apiBase: string, handle?: string): string | null {
  const id = resolveIdentity(identityHome)
  if (id === null || id.apiBase !== apiBase) return null
  if (handle !== undefined && id.source === 'file' && id.handle !== null && id.handle !== handle) return null
  return id.apiKey
}

/** The preset's runner with this integration's deny list and, for answer runs, its AgentChat-only tool config. */
export class ClaudeRunner extends PresetClaudeRunner {
  constructor(options: IntegrationRunnerOptions) {
    const { apiBase, identityHome: given, handle, ...rest } = options
    const identityHome = given !== undefined ? path.resolve(given) : identityHomeFor(options.configDir)
    const deny = denyReadPathsFor(options.configDir)
    super({
      ...rest,
      denyReadPaths: deny.includes(identityHome) ? deny : [identityHome, ...deny],
      answerMcp: {
        file: answerToolConfigFor(identityHome),
        apiBase,
        // Read for each run: a run follows the credential as it is when it starts (`answerRunKey`).
        apiKey: () => answerRunKey(identityHome, apiBase, handle),
        clientVersion: VERSION,
      },
      workdirAdvice: `Point AGENTCHAT_RUN_CWD outside it, or unset it for the default ${runWorkdirFor(options.configDir)}, then re-run \`${invocation()} daemon install\``,
    })
  }
}

/**
 * The files an answer run writes for itself in `<identity home>/presets/` —
 * its tool config (`claude-code.mcp.<run id>.json`, which holds the key), its
 * identity line (`claude-code.mcp.<run id>.identity.md`) and the temp files of
 * their atomic writes. Each run removes its own when it ends; a run cut off
 * (the machine lost power, the daemon was killed) leaves them behind.
 */
function answerRunFilePattern(stem: string): RegExp {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\.?${escaped}\\.[A-Za-z0-9-]{1,64}\\.(json|identity\\.md)(\\.[0-9a-f]{12}\\.tmp)?$`)
}

/**
 * Remove what answer runs left in `<identity home>/presets/` (`answerRunFilePattern`),
 * and the folder when nothing else is in it. For logout (a left-behind tool
 * config holds the key) and uninstall. Returns what was removed; never throws.
 */
export function removeAnswerRunFiles(identityHome: string): { removed: string[]; failed: string[] } {
  const config = answerToolConfigFor(identityHome)
  const dir = path.dirname(config)
  const stem = path.basename(config, path.extname(config))
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { removed: [], failed: [] }
  }
  const pattern = answerRunFilePattern(stem)
  const removed: string[] = []
  const failed: string[] = []
  for (const name of names.filter((n) => pattern.test(n))) {
    try {
      fs.rmSync(path.join(dir, name), { force: true })
      removed.push(name)
    } catch {
      failed.push(name)
    }
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    /* not empty, or already gone */
  }
  return { removed, failed }
}

/**
 * The line a run prompt ends with: where the manual is (the `agentchat`
 * skill). An `answer` run cannot open it — the skill file is outside its work
 * folder and it has no web — so its prompt ends with the served instruction
 * alone: the hosted tools and the served texts are everything it has. `work`
 * and `full` runs read files and the web, and get the pointer.
 */
export function runPointer(profile: RunProfile, skill: string): string {
  return profile === 'answer' ? '' : manualPointer(`at ${skill}`)
}

/** ` — <the engine's warning>` after a `work` or `full` profile name (`runProfileWarning`); nothing after `answer`. */
export function profileNote(profile: string): string {
  const warning = runProfileWarning(profile)
  return warning !== null ? ` — ${warning}` : ''
}
