import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { atomicWriteFile, log } from '@agentchatme/agent-core'
import { buildAgentChatTurnPrompt } from '@agentchatme/agent-core/daemon'
import type { RuntimeAdapter, TurnContext, TurnResult } from '@agentchatme/agent-core/daemon'
import { VERSION } from './version.js'

// ─── Claude Code adapter ────────────────────────────────────────────────────
//
// Drives `claude -p` (headless print mode) on the box, riding the user's
// Claude subscription (auth in CLAUDE_CONFIG_DIR/.credentials.json). Each
// AgentChat conversation maps to a STABLE claude session id (derived from the
// conversation id) so turn N remembers turns 1..N-1.
//
// Empirically load-bearing (verified 2026-07-23 against claude 2.1.216):
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
export const AGENTCHAT_MCP_PACKAGE = '@agentchatme/mcp@0.1.11214'
export const AGENTCHAT_TOOL_ALLOW = 'mcp__agentchat'

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
export function claudeIsLoggedIn(configDir: string): boolean {
  const status = spawnSync('claude', ['auth', 'status'], {
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  })
  if (!status.error && status.status === 0) return true

  // Compatibility fallback for older Claude Code builds that predate
  // `claude auth status`. It is deliberately existence-only.
  if (fs.existsSync(path.join(configDir, '.credentials.json'))) return true
  if (process.platform !== 'darwin') return false
  const keychain = spawnSync(
    'security',
    ['find-generic-password', '-s', 'Claude Code-credentials'],
    { encoding: 'utf-8', timeout: 5_000 },
  )
  return !keychain.error && keychain.status === 0
}

export function buildClaudeEnv(
  configDir: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of PARENT_ENV_KEYS) delete env[key]
  env['CLAUDE_CONFIG_DIR'] = configDir
  env['DISABLE_AUTOUPDATER'] = '1'
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
): Record<string, unknown> {
  return {
    mcpServers: {
      agentchat: {
        command: 'npx',
        args: ['-y', AGENTCHAT_MCP_PACKAGE],
        env: {
          AGENTCHAT_HOME: identityHome,
          AGENTCHAT_CLIENT_NAME: 'claude-code',
          AGENTCHAT_CLIENT_VERSION: VERSION,
        },
      },
    },
  }
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
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

export class ClaudeAdapter implements RuntimeAdapter {
  readonly name = 'claude-code'
  // conversationId → true once we've created its session this process.
  private readonly started = new Set<string>()
  private sessionNamespace = 'unbound'

  constructor(
    private readonly claudeConfigDir: string,
    private readonly identityHome: string,
    private readonly workdir: string,
  ) {}

  reset(identityNamespace: string): void {
    this.started.clear()
    this.sessionNamespace = identityNamespace
  }

  async preflight(): Promise<{ ok: boolean; detail?: string }> {
    const which = spawnSync('claude', ['--version'], { encoding: 'utf-8' })
    if (which.error) return { ok: false, detail: 'claude CLI not found on PATH' }
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
        JSON.stringify(buildTurnMcpConfig(this.identityHome)),
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
      const child = spawn('claude', args, {
        cwd: this.workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        detached: process.platform !== 'win32',
      })
      let sawSend = false
      let isError: boolean | undefined
      let buf = ''
      let stderr = ''

      child.stdout.on('data', (d) => {
        buf += d
        // stream-json is newline-delimited JSON events. Detect an
        // agentchat_send_message tool call and the terminal result.
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          try {
            const e = JSON.parse(line)
            if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
              for (const c of e.message.content) {
                if (c?.type === 'tool_use' && typeof c.name === 'string' && c.name.includes('agentchat_send_message')) {
                  sawSend = true
                }
              }
            }
            if (e.type === 'result') isError = e.is_error === true
          } catch {
            /* partial or non-json line */
          }
        }
        if (buf.length > MAX_EVENT_TAIL_CHARS) buf = buf.slice(-MAX_EVENT_TAIL_CHARS)
      })
      child.stderr.on('data', (d) => {
        if (stderr.length < MAX_STDERR_CHARS) {
          stderr += String(d).slice(0, MAX_STDERR_CHARS - stderr.length)
        }
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
        // We DISCARD the turn text — the reply (if any) went via the MCP send
        // tool. Success = clean exit AND the result event wasn't an error.
        if (code === 0 && isError !== true) {
          log.info(`claude turn done for ${ctx.conversationId} (sent=${sawSend})`)
          finish({ ok: true, detail: sawSend ? 'replied' : 'silent' })
        } else {
          const detail = `claude exited ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
          finish({ ok: false, fatal: fatalRuntimeError(detail), detail })
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
