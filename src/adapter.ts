import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import {
  atomicWriteFile,
  log,
  spawnCommand,
  spawnCommandSync,
} from '@agentchatme/agent-core'
import {
  buildAgentChatTurnPrompt,
  parseAgentChatTurnOutcome,
  resolveTurnDisposition,
} from '@agentchatme/agent-core/daemon'
import type {
  RuntimeAdapter,
  TurnContext,
  TurnDisposition,
  TurnResult,
} from '@agentchatme/agent-core/daemon'
import { VERSION } from './version.js'
import {
  MIN_CLAUDE_CODE_VERSION,
  semverAtLeast,
} from './runtime-version.js'

// ─── Claude Code adapter ────────────────────────────────────────────────────
//
// Drives `claude -p` (headless print mode) on the box, riding the user's
// Claude subscription through Claude's normal auth lookup. CLAUDE_CONFIG_DIR
// is passed only when the user explicitly configured it; setting it to the
// apparent default is observably different from leaving it unset. Each
// AgentChat conversation maps to a STABLE claude session id (derived from the
// conversation id) so turn N remembers turns 1..N-1.
//
// Empirically load-bearing (verified 2026-07-30 against claude 2.1.220):
//   * The prompt goes on STDIN, not as a positional — the variadic
//     `--allowedTools` otherwise swallows a trailing positional prompt.
//   * `--session-id <uuid>` CREATES a session and ERRORS "already in use" if it
//     exists; `--resume <uuid>` RESUMES and errors "No conversation found" if
//     it doesn't. So: session-id for the first turn, resume after — with a
//     resume-fallback when a restart lost our in-memory "started" set but the
//     session persists on disk.
//   * `--allowedTools` PRE-APPROVES; it does not restrict availability. We use
//     it for the full AgentChat MCP server. Built-in tools, web access,
//     settings, instructions, plugins, skills, MCP servers, and permission
//     behavior remain under the user's normal Claude Code configuration.
//     AgentChat does not select a separate capability level.
//   * CLAUDE_CODE_* / CLAUDECODE env from a parent Claude session is stripped
//     so the child doesn't think it's a nested session.

const TURN_TIMEOUT_MS = 240_000
const MAX_EVENT_TAIL_CHARS = 1024 * 1024
const MAX_STDERR_CHARS = 16_384
const MAX_DIAGNOSTIC_CHARS = 500
export const AGENTCHAT_MCP_PACKAGE = '@agentchatme/mcp@0.1.1121411'
export const AGENTCHAT_TOOL_ALLOW = 'mcp__agentchat__*'

// Env a parent Claude Code session leaks that would confuse a child `claude`.
const PARENT_ENV_KEYS = [
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
 * Is Claude Code signed in?
 *
 * NOT just `<config>/.credentials.json`. On macOS Claude Code keeps its
 * credentials in the login Keychain (service `Claude Code-credentials`) and
 * writes no such file — so a file-only check reports "not logged in" on every
 * Mac, forever. Always-on could never connect on macOS, and the only trace was
 * one line in a log nobody reads.
 *
 * The keychain probe is existence-only: `find-generic-password` without `-w`
 * returns metadata, never the secret, does not prompt, and takes ~10ms. A
 * daemon must never trigger a keychain prompt, so reading the secret is not an
 * option even if we wanted it.
 */
function claudeProcessEnv(
  configDirOverride: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source }
  if (configDirOverride === undefined) delete env['CLAUDE_CONFIG_DIR']
  else env['CLAUDE_CONFIG_DIR'] = configDirOverride
  return env
}

export function claudeIsLoggedIn(configDirOverride?: string): boolean {
  const status = spawnCommandSync('claude', ['auth', 'status'], {
    encoding: 'utf-8',
    timeout: 10_000,
    env: claudeProcessEnv(configDirOverride),
  })
  if (!status.error && status.status === 0) return true

  // Compatibility fallback for older Claude Code builds that predate
  // `claude auth status`. It is deliberately existence-only.
  const configDir = configDirOverride ?? path.join(os.homedir(), '.claude')
  if (fs.existsSync(path.join(configDir, '.credentials.json'))) return true
  if (process.platform !== 'darwin') return false
  const keychain = spawnCommandSync(
    'security',
    ['find-generic-password', '-s', 'Claude Code-credentials'],
    { encoding: 'utf-8', timeout: 5_000 },
  )
  return !keychain.error && keychain.status === 0
}

export function buildClaudeEnv(
  configDirOverride: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = claudeProcessEnv(configDirOverride, source)
  for (const key of PARENT_ENV_KEYS) delete env[key]
  env['DISABLE_AUTOUPDATER'] = '1'
  // `alwaysLoad` guarantees the send tool is present on the first prompt, but
  // Claude's default blocking snapshot is only five seconds. An uncached npx
  // MCP launch can legitimately take longer. Give this isolated unattended
  // child the same 30-second budget as an MCP server's default startup timer,
  // while preserving any larger operator-provided value.
  const configuredConnectTimeout = Number(env['MCP_CONNECT_TIMEOUT_MS'])
  if (
    !Number.isFinite(configuredConnectTimeout) ||
    configuredConnectTimeout < 30_000
  ) {
    env['MCP_CONNECT_TIMEOUT_MS'] = '30000'
  }
  // The unattended child reads the same user configuration as the interactive
  // host. It must not recursively run AgentChat's own SessionStart/Stop hooks:
  // those would announce a false foreground turn and contend for this inbox.
  // Other user hooks, skills, plugins, MCP servers and permissions stay intact.
  env['AGENTCHAT_HOOKS_ENABLED'] = '0'
  env['AGENTCHAT_EXECUTION'] = 'always_on'
  return env
}

/** Exported so tests pin the real autonomous launch contract. */
export function buildClaudeArgs(
  ctx: TurnContext,
  mcpConfigPath: string,
  uuid: string,
  resume: boolean,
): string[] {
  const sessionArgs = resume ? ['--resume', uuid] : ['--session-id', uuid]
  return [
    '-p',
    ...sessionArgs,
    '--mcp-config',
    mcpConfigPath,
    '--allowedTools',
    AGENTCHAT_TOOL_ALLOW,
    '--output-format',
    'stream-json',
    '--verbose',
  ]
}

export function buildTurnMcpConfig(
  identityHome: string,
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    mcpServers: {
      agentchat: {
        command: 'npx',
        args: ['-y', AGENTCHAT_MCP_PACKAGE],
        // Without this, Claude can emit system/init while the server is still
        // pending and begin a turn that has no AgentChat send tool.
        alwaysLoad: true,
        env: {
          AGENTCHAT_HOME: identityHome,
          AGENTCHAT_CLIENT_NAME: 'claude-code',
          AGENTCHAT_CLIENT_VERSION: VERSION,
          AGENTCHAT_TURN_IDEMPOTENCY_KEY: idempotencyKey,
          AGENTCHAT_EXECUTION: 'always_on',
        },
      },
    },
  }
}

export function turnIdempotencyKey(
  ctx: TurnContext,
  identityNamespace: string,
): string {
  const messageIds = ctx.pendingBatch?.messageIds ?? [ctx.messageId]
  const digest = crypto
    .createHash('sha256')
    .update('agentchat-daemon-turn-v1\0')
    .update(identityNamespace)
    .update('\0')
    .update(ctx.conversationId)
    .update('\0')
    .update(messageIds.join('\0'))
    .digest('hex')
  return `ac_turn_${digest}`
}

const SEND_TOOL = 'mcp__agentchat__agentchat_send_message'

function boundedDiagnostic(value: string): string {
  return value
    // Terminal styling makes launchd logs unreadable and can hide text from
    // simple searches. Strip CSI escape sequences before bounding the line.
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    // Runtime stderr and structured API errors are useful, but credentials
    // never are. Cover the key shapes either integration or Claude commonly
    // emits without trying to preserve a secret prefix.
    .replace(/\b(api[_ -]?key\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~-]{8,}\b/gi, '$1 [redacted]')
    .replace(/\bac_[A-Za-z0-9_-]{8,}\b/g, '[redacted AgentChat key]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, '[redacted Anthropic key]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC_CHARS)
}

function diagnosticToken(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const rendered = String(value).trim()
  return /^[A-Za-z0-9_.:/-]{1,80}$/.test(rendered) ? rendered : null
}

function nestedErrorDetail(value: unknown): string | null {
  if (typeof value === 'string') return boundedDiagnostic(value) || null
  if (typeof value !== 'object' || value === null) return null
  const error = value as Record<string, unknown>
  const labels = ['type', 'code', 'name', 'status', 'status_code'].flatMap((key) => {
    const token = diagnosticToken(error[key])
    return token === null ? [] : [`${key}=${token}`]
  })
  const message =
    typeof error['message'] === 'string'
      ? boundedDiagnostic(error['message'])
      : ''
  return boundedDiagnostic(
    [...labels, ...(message ? [message] : [])].join(labels.length > 0 ? '; ' : ''),
  ) || null
}

/** Extract only protocol/control-plane failures. Assistant result text is
 * deliberately excluded because it can contain peer-authored content. */
function controlFailureDetail(record: Record<string, unknown>): string | null {
  const type = diagnosticToken(record['type'])
  const subtype = diagnosticToken(record['subtype'])
  const terminalFailure =
    type === 'result' &&
    (record['is_error'] === true || (subtype !== null && subtype !== 'success'))
  const controlFailure =
    type === 'error' ||
    (type === 'system' && subtype !== null && /error|fail/i.test(subtype))
  if (!terminalFailure && !controlFailure) return null

  const label = terminalFailure
    ? `terminal result ${subtype ?? 'reported an error'}`
    : `stream ${[type, subtype].filter(Boolean).join('/') || 'error'}`
  const error = nestedErrorDetail(record['error'])
  const permissionDenials = Array.isArray(record['permission_denials'])
    ? record['permission_denials'].length
    : 0
  return boundedDiagnostic(
    [
      label,
      ...(error ? [error] : []),
      ...(permissionDenials > 0
        ? [`${permissionDenials} permission denial(s)`]
        : []),
    ].join('; '),
  )
}

/** Delivery-critical state from Claude's stream-json protocol. */
export class ClaudeTurnEvents {
  private initSeen = false
  private mcpConnected = false
  private initFailure: string | null = null
  private terminalSeen = false
  private terminalFailure = false
  private readonly pending = new Set<string>()
  private successfulSends = 0
  private sendFailure: string | null = null
  private runtimeAuthFailure: string | null = null
  private controlFailure: string | null = null
  private reportedDisposition: TurnDisposition | null = null

  consume(event: unknown): void {
    if (typeof event !== 'object' || event === null) return
    const record = event as Record<string, unknown>
    this.controlFailure ??= controlFailureDetail(record)

    if (record['type'] === 'system' && record['subtype'] === 'init') {
      this.initSeen = true
      const servers = Array.isArray(record['mcp_servers'])
        ? record['mcp_servers']
        : []
      const agentchat = servers.find(
        (candidate) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          (candidate as Record<string, unknown>)['name'] === 'agentchat',
      ) as Record<string, unknown> | undefined
      this.mcpConnected = agentchat?.['status'] === 'connected'
      if (!this.mcpConnected) {
        const status =
          typeof agentchat?.['status'] === 'string'
            ? agentchat['status']
            : 'missing'
        this.initFailure = `AgentChat MCP status is ${status}`
      }

      const skipped = Array.isArray(record['mcp_server_errors'])
        ? record['mcp_server_errors']
        : []
      const error = skipped.find(
        (candidate) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          (candidate as Record<string, unknown>)['name'] === 'agentchat',
      ) as Record<string, unknown> | undefined
      if (error !== undefined) {
        const message =
          typeof error['message'] === 'string'
            ? boundedDiagnostic(error['message'])
            : ''
        this.initFailure = `AgentChat MCP configuration was skipped${message ? `: ${message}` : ''}`
      }
    }

    if (record['type'] === 'assistant') {
      const message = record['message'] as Record<string, unknown> | undefined
      const content = Array.isArray(message?.['content'])
        ? message['content']
        : []
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue
        const tool = block as Record<string, unknown>
        if (
          tool['type'] === 'text' &&
          typeof tool['text'] === 'string'
        ) {
          this.reportedDisposition =
            parseAgentChatTurnOutcome(tool['text']) ??
            this.reportedDisposition
          if (fatalRuntimeError(tool['text'])) {
            this.runtimeAuthFailure = boundedDiagnostic(tool['text'])
          }
        }
        if (
          tool['type'] === 'tool_use' &&
          tool['name'] === SEND_TOOL &&
          typeof tool['id'] === 'string'
        ) {
          this.pending.add(tool['id'])
        }
      }
    }

    if (record['type'] === 'user') {
      const message = record['message'] as Record<string, unknown> | undefined
      const content = Array.isArray(message?.['content'])
        ? message['content']
        : []
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue
        const result = block as Record<string, unknown>
        const id =
          typeof result['tool_use_id'] === 'string'
            ? result['tool_use_id']
            : null
        if (
          result['type'] !== 'tool_result' ||
          id === null ||
          !this.pending.has(id)
        ) {
          continue
        }
        this.pending.delete(id)
        if (result['is_error'] === true) {
          this.sendFailure = 'AgentChat send tool returned an error'
        } else {
          this.successfulSends += 1
        }
      }
    }

    if (record['type'] === 'result') {
      this.terminalSeen = true
      this.terminalFailure =
        record['is_error'] === true ||
        (typeof record['subtype'] === 'string' &&
          record['subtype'] !== 'success')
    }
  }

  outcome(): {
    ok: boolean
    sent: boolean
    disposition?: TurnDisposition
    detail?: string
  } {
    if (!this.initSeen) {
      return { ok: false, sent: false, detail: 'Claude emitted no system/init event' }
    }
    if (!this.mcpConnected || this.initFailure !== null) {
      return {
        ok: false,
        sent: this.successfulSends > 0,
        detail: this.initFailure ?? 'AgentChat MCP did not connect',
      }
    }
    if (!this.terminalSeen || this.terminalFailure) {
      return {
        ok: false,
        sent: this.successfulSends > 0,
        detail: this.terminalSeen
          ? 'Claude reported a failed terminal result'
          : 'Claude emitted no terminal result event',
      }
    }
    if (this.sendFailure !== null) {
      return {
        ok: false,
        sent: this.successfulSends > 0,
        detail: this.sendFailure,
      }
    }
    if (this.pending.size > 0) {
      return {
        ok: false,
        sent: this.successfulSends > 0,
        detail: `${this.pending.size} AgentChat send tool call(s) never completed`,
      }
    }
    const sent = this.successfulSends > 0
    return {
      ok: true,
      sent,
      disposition: resolveTurnDisposition(sent, this.reportedDisposition),
    }
  }

  /** Claude reports host-auth failures as assistant text on stdout rather than
   * stderr. Keep only the matching bounded diagnostic; ordinary model text is
   * never surfaced as a runtime error. */
  fatalDetail(): string | null {
    return this.runtimeAuthFailure
  }

  /** A bounded, non-peer-text explanation of how far the Claude protocol got
   * before a non-zero process exit. */
  exitDetail(): string {
    if (this.runtimeAuthFailure) return this.runtimeAuthFailure
    if (this.controlFailure) return this.controlFailure
    if (this.initFailure) return boundedDiagnostic(this.initFailure)
    if (this.terminalSeen && this.terminalFailure) {
      return 'Claude emitted a failed terminal result'
    }
    if (this.initSeen) {
      return this.mcpConnected
        ? 'Claude exited after initialization with AgentChat MCP connected but no successful terminal result'
        : 'Claude exited after initialization before AgentChat MCP connected'
    }
    return 'Claude exited before the system/init event'
  }
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawnCommandSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

function fatalRuntimeError(detail: string): boolean {
  return /not logged in|authentication|unauthorized|invalid api key|login required/i.test(detail)
}

/** Convert a non-zero Claude exit into the daemon contract. Exported so the
 * observed stdout-only login failure remains pinned by a regression test. */
export function classifyClaudeExit(
  code: number | null,
  stderr: string,
  events: ClaudeTurnEvents,
): TurnResult {
  const structured = events.fatalDetail()
  const diagnostics = [structured, boundedDiagnostic(stderr), events.exitDetail()]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
  const diagnostic = boundedDiagnostic(diagnostics.join('; '))
  const detail = `claude exited ${code ?? 'without a status'}${diagnostic ? `: ${diagnostic}` : ''}`
  return {
    ok: false,
    fatal: structured !== null || fatalRuntimeError(detail),
    detail,
  }
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly name = 'claude-code'
  // conversationId → true once we've created its session this process.
  private readonly started = new Set<string>()
  private sessionNamespace = 'unbound'

  constructor(
    private readonly claudeConfigDir: string | undefined,
    private readonly identityHome: string,
    private readonly workdir: string,
  ) {}

  reset(identityNamespace: string): void {
    this.started.clear()
    this.sessionNamespace = identityNamespace
  }

  async preflight(): Promise<{ ok: boolean; detail?: string }> {
    const which = spawnCommandSync('claude', ['--version'], { encoding: 'utf-8' })
    if (which.error) return { ok: false, detail: 'claude CLI not found on PATH' }
    const rendered = String(which.stdout || which.stderr).trim()
    if (which.status !== 0 || !semverAtLeast(rendered, MIN_CLAUDE_CODE_VERSION)) {
      return {
        ok: false,
        detail:
          `${rendered || `claude exited ${which.status}`}; AgentChat requires ` +
          `Claude Code >= ${MIN_CLAUDE_CODE_VERSION}`,
      }
    }
    if (!claudeIsLoggedIn(this.claudeConfigDir)) {
      return { ok: false, detail: 'claude is not logged in (run `claude` once and sign in)' }
    }
    fs.mkdirSync(this.workdir, { recursive: true })
    return { ok: true }
  }

  async runTurn(ctx: TurnContext): Promise<TurnResult> {
    const uuid = sessionUuid(ctx.conversationId, this.sessionNamespace)
    const resume = this.started.has(ctx.conversationId)
    let result = await this.spawn(uuid, resume, ctx)
    // Restart recovery: we thought this was a first turn, but the session
    // already exists on disk from before a restart — resume it instead.
    if (!result.ok && !resume && /already in use/i.test(result.detail ?? '')) {
      log.info(`claude session for ${ctx.conversationId} exists on disk — resuming`)
      result = await this.spawn(uuid, true, ctx)
    } else if (!result.ok && resume && /no conversation found/i.test(result.detail ?? '')) {
      // A user can clear Claude's persisted history while this resident daemon
      // still remembers that it created the session. Start it again instead of
      // retrying a permanently missing resume target.
      log.info(`claude session for ${ctx.conversationId} disappeared — recreating`)
      this.started.delete(ctx.conversationId)
      result = await this.spawn(uuid, false, ctx)
    }
    if (result.ok) this.started.add(ctx.conversationId)
    return result
  }

  private spawn(uuid: string, resume: boolean, ctx: TurnContext): Promise<TurnResult> {
    // One stable config file per conversation avoids concurrent writers and is
    // overwritten before each sequential turn in that conversation.
    const configName = crypto
      .createHash('sha256')
      .update(`${this.sessionNamespace}:${ctx.conversationId}`)
      .digest('hex')
      .slice(0, 24)
    const mcpConfigPath = path.join(this.workdir, `agentchat-mcp-${configName}.json`)
    try {
      atomicWriteFile(
        mcpConfigPath,
        JSON.stringify(
          buildTurnMcpConfig(
            this.identityHome,
            turnIdempotencyKey(ctx, this.sessionNamespace),
          ),
        ),
        0o600,
      )
    } catch (err) {
      return Promise.resolve({ ok: false, detail: `could not write MCP config: ${String(err)}` })
    }
    const args = buildClaudeArgs(ctx, mcpConfigPath, uuid, resume)

    const env = buildClaudeEnv(this.claudeConfigDir)

    return new Promise<TurnResult>((resolve) => {
      let settled = false
      const finish = (result: TurnResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const child = spawnCommand('claude', args, {
        cwd: this.workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        detached: process.platform !== 'win32',
      })
      const events = new ClaudeTurnEvents()
      let buf = ''
      let stderr = ''
      const consumeLine = (line: string): void => {
        if (!line.trim()) return
        try {
          events.consume(JSON.parse(line))
        } catch {
          /* malformed CLI output is ignored; close status remains authoritative */
        }
      }

      child.stdout.on('data', (d) => {
        buf += String(d)
        // stream-json is newline-delimited JSON events.
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          consumeLine(line)
        }
        if (buf.length > MAX_EVENT_TAIL_CHARS) buf = buf.slice(-MAX_EVENT_TAIL_CHARS)
      })
      child.stderr.on('data', (d) => {
        // Preserve the most recent bounded tail: command runners commonly
        // print the actionable reason only after setup/progress chatter.
        stderr = (stderr + String(d)).slice(-MAX_STDERR_CHARS)
      })

      // The prompt goes on stdin (see header) — write it and close.
      try {
        child.stdin.write(buildPrompt(ctx))
        child.stdin.end()
      } catch {
        /* stdin already gone; the child will exit and be handled below */
      }

      const killTimer = setTimeout(() => {
        killProcessTree(child)
        finish({ ok: false, detail: 'turn timed out' })
      }, TURN_TIMEOUT_MS)

      child.on('error', (err) => {
        clearTimeout(killTimer)
        finish({ ok: false, fatal: true, detail: `claude spawn failed: ${String(err)}` })
      })

      child.on('close', (code) => {
        clearTimeout(killTimer)
        consumeLine(buf)
        // We DISCARD the turn text — the reply (if any) went via the MCP send
        // tool. Success requires a connected MCP server, a clean terminal
        // result, and completed tool results for every attempted send.
        if (code === 0) {
          const outcome = events.outcome()
          if (!outcome.ok) {
            finish({
              ok: false,
              detail: outcome.detail ?? 'AgentChat send outcome was not successful',
            })
            return
          }
          log.info(`claude turn done for ${ctx.conversationId} (sent=${outcome.sent})`)
          finish({
            ok: true,
            detail: outcome.sent ? 'replied' : 'silent',
            ...(outcome.disposition
              ? { disposition: outcome.disposition }
              : {}),
          })
        } else {
          finish(classifyClaudeExit(code, stderr, events))
        }
      })
    })
  }
}

/** Deterministic, valid UUIDv5-shaped session id for a conversation, so a
 *  restart resumes the same claude session without tracking ids. Exported for
 *  tests — its determinism is what makes restart-resume work. */
export function sessionUuid(conversationId: string, identityNamespace = 'unbound'): string {
  const h = crypto
    .createHash('sha1')
    .update(`agentchat-daemon:${identityNamespace}:${conversationId}`)
    .digest('hex')
  const variant = ((parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Exported for tests — the first-touch orientation string is the whole point
 *  of the enrichment, so it is worth pinning. */
export function buildPrompt(ctx: TurnContext): string {
  return buildAgentChatTurnPrompt(ctx)
}
