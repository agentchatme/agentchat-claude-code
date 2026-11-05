import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { log, spawnCommandSync, type RunProfile } from '@agentchatme/agent-core'
import { spawnRun, type RunOutcome, type RunRequest, type RunRunner } from '@agentchatme/agent-core/daemon'
import { claudeUserStatePathFor, identityHomeFor, invocation, runWorkdirFor } from './host.js'
import { claudeRunArgs } from './profile.js'
import { MIN_CLAUDE_CODE_VERSION, semverAtLeast } from './runtime-version.js'

// ─── One headless run of Claude Code ────────────────────────────────────────
//
// `claude -p` on the box, riding the user's own Claude Code sign-in and user
// configuration. The hosted AgentChat tools reach the run through the
// user-scope MCP server the installer registered (`mcp__agentchat__*`); the
// profile decides what else the run may touch. The run's output is discarded
// by `spawnRun`: the agent's only way to say anything on AgentChat is the
// hosted send tool during the run.

/** Env a parent Claude Code session leaks that would make the child think it is nested. */
export const PARENT_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_EFFORT',
  'AI_AGENT',
]

/**
 * How long the first turn of a `-p` run waits for a still-connecting MCP
 * server that `--allowedTools` names: `CLAUDE_CODE_MCP_STARTUP_WAIT_MS`, in
 * Claude Code since 2.1.274 (the floor in runtime-version.ts). Claude Code's
 * own built-in wait is short — 2.1.284 made the first turn "still wait up to
 * 2s" even when the variable is 0 — and a remote server over a cold network
 * can take longer; the run must not start without the inbox tool.
 */
const MCP_STARTUP_WAIT_MS = '15000'

function claudeProcessEnv(configDirOverride: string | undefined, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  if (configDirOverride === undefined) delete env['CLAUDE_CONFIG_DIR']
  else env['CLAUDE_CONFIG_DIR'] = configDirOverride
  return env
}

export function buildClaudeEnv(configDirOverride: string | undefined, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = claudeProcessEnv(configDirOverride, source)
  for (const key of PARENT_ENV_KEYS) delete env[key]
  env['DISABLE_AUTOUPDATER'] = '1'
  const wait = Number(env['CLAUDE_CODE_MCP_STARTUP_WAIT_MS'])
  if (!Number.isFinite(wait) || wait < Number(MCP_STARTUP_WAIT_MS)) env['CLAUDE_CODE_MCP_STARTUP_WAIT_MS'] = MCP_STARTUP_WAIT_MS
  return env
}

/**
 * Is Claude Code signed in? `claude auth status` prints JSON with a boolean
 * `loggedIn` and exits 0 if logged in, 1 if not
 * (code.claude.com/docs/en/cli-reference.md). When that JSON is there it is
 * the answer. The file/keychain probes are a fallback for builds without the
 * subcommand; the keychain probe is existence-only and never prompts — a
 * daemon must never trigger a keychain prompt.
 */
export function claudeIsLoggedIn(configDirOverride?: string, command = 'claude'): boolean {
  const status = spawnCommandSync(command, ['auth', 'status'], {
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
    env: claudeProcessEnv(configDirOverride, process.env),
  })
  if (!status.error) {
    try {
      const parsed = JSON.parse(String(status.stdout ?? '').trim()) as { loggedIn?: unknown }
      if (typeof parsed?.loggedIn === 'boolean') return parsed.loggedIn
    } catch {
      /* no JSON: an older build; fall through to the file and keychain */
    }
    if (status.status === 0) return true
  }

  const configDir = configDirOverride ?? path.join(os.homedir(), '.claude')
  if (fs.existsSync(path.join(configDir, '.credentials.json'))) return true
  if (process.platform !== 'darwin') return false
  const keychain = spawnCommandSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
    encoding: 'utf-8',
    timeout: 5_000,
  })
  return !keychain.error && keychain.status === 0
}

export interface ClaudeRuntimeInspection {
  ok: boolean
  detail: string
}

export function inspectClaudeRuntime(configDirOverride?: string, command = 'claude'): ClaudeRuntimeInspection {
  const version = spawnCommandSync(command, ['--version'], {
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
    env: claudeProcessEnv(configDirOverride, process.env),
  })
  if (version.error) return { ok: false, detail: `claude CLI not found on PATH (${version.error.message})` }
  const rendered = String(version.stdout || version.stderr).trim()
  if (version.status !== 0) return { ok: false, detail: rendered || `claude --version exited ${version.status}` }
  return semverAtLeast(rendered, MIN_CLAUDE_CODE_VERSION)
    ? { ok: true, detail: rendered }
    : {
        ok: false,
        detail: `${rendered || 'unrecognized version'}; AgentChat requires Claude Code >= ${MIN_CLAUDE_CODE_VERSION} (for --permission-prompts none and CLAUDE_CODE_MCP_STARTUP_WAIT_MS)`,
      }
}

/**
 * The key store, denied to every run's file tools: the identity home
 * (credentials, status, logs) and ~/.claude.json, where the user-scope MCP
 * entry carries the key. A run judging peer text must not be able to read
 * either and send it. ONE list, so what `args()` denies and what the workdir
 * is checked against cannot drift apart.
 */
export function denyReadPathsFor(configDirOverride: string | undefined): string[] {
  return [identityHomeFor(configDirOverride), claudeUserStatePathFor(configDirOverride)]
}

/**
 * The entry of `denied` that is `dir` or contains it, or null. Whole path
 * segments only: `~/.claude/agentchat` does not contain `~/.claude/agentchat-workdir`.
 */
export function deniedAncestorOf(dir: string, denied: readonly string[]): string | null {
  const target = path.resolve(dir)
  for (const raw of denied) {
    const root = path.resolve(raw)
    if (target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return root
  }
  return null
}

export interface ClaudeRunnerOptions {
  readonly configDir: string | undefined
  /**
   * The run's working directory; the `work` profile edits and runs shell here.
   * Must lie outside `denyReadPathsFor(configDir)`, or the run cannot read its
   * own cwd — preflight says so once and still runs.
   */
  readonly workdir: string
  readonly profile: RunProfile
  /** Test seam: the binary to run. */
  readonly command?: string
  readonly env?: NodeJS.ProcessEnv
}

export class ClaudeRunner implements RunRunner {
  readonly name = 'claude'
  private readonly command: string
  /** The workdir warning is one line per daemon, not one per preflight (preflight repeats every few minutes). */
  private warnedWorkdir = false

  constructor(private readonly options: ClaudeRunnerOptions) {
    this.command = options.command ?? 'claude'
  }

  /** The denied path the configured workdir sits in, or null when the run can read its own cwd. */
  workdirDeniedBy(): string | null {
    return deniedAncestorOf(this.options.workdir, denyReadPathsFor(this.options.configDir))
  }

  async preflight() {
    const runtime = inspectClaudeRuntime(this.options.configDir, this.command)
    if (!runtime.ok) return { ok: false, detail: runtime.detail }
    if (!claudeIsLoggedIn(this.options.configDir, this.command)) {
      return { ok: false, detail: 'claude is not signed in (run `claude` once and sign in)' }
    }
    // A cwd inside the key store is an operator choice (AGENTCHAT_RUN_CWD or
    // --workdir) the deny rules then make unreadable to the run. Said once,
    // with the fix; the run still starts — the hosted tools do not need the cwd.
    const denied = this.workdirDeniedBy()
    if (denied !== null && !this.warnedWorkdir) {
      this.warnedWorkdir = true
      log.warn(
        `the run workdir ${this.options.workdir} is inside ${denied}, which every run's file tools are denied: runs cannot read their own working directory. Point AGENTCHAT_RUN_CWD outside it, or unset it for the default ${runWorkdirFor(this.options.configDir)}, then re-run \`${invocation()} daemon install\``,
      )
    }
    // Owner-only on creation, as the identity home is. Creation only: an
    // operator's own workspace (AGENTCHAT_RUN_CWD) keeps its permissions.
    fs.mkdirSync(this.options.workdir, { recursive: true, mode: 0o700 })
    return { ok: true }
  }

  /** The exact argv one run uses — exported for tests to pin per profile. */
  args(): string[] {
    return claudeRunArgs(this.options.profile, {
      maxBudgetUsd: (this.options.env ?? process.env)['AGENTCHAT_RUN_MAX_BUDGET_USD'],
      denyReadPaths: denyReadPathsFor(this.options.configDir),
    })
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    const args = this.args()
    log.debug(`claude ${args.join(' ')} (prompt on stdin, ${request.kind} run ${request.runId})`)
    return spawnRun({
      command: this.command,
      args,
      cwd: this.options.workdir,
      env: buildClaudeEnv(this.options.configDir, this.options.env ?? process.env),
      stdin: request.prompt,
      budgetMs: request.budgetMs,
      // The integration stopping (shutdown, identity change, refused key)
      // SIGTERMs this run's process group instead of orphaning it.
      ...(request.signal ? { signal: request.signal } : {}),
      // The engine records a group invite as offered the moment the process
      // has spawned, so a run cut short still counts as the one offer.
      ...(request.onStarted ? { onStarted: request.onStarted } : {}),
    })
  }
}
