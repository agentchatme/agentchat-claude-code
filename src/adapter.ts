import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { log } from '@agentchatme/agent-core'
import { formatWhen } from '@agentchatme/agent-core'
import { describeConversation, describeSender } from '@agentchatme/agent-core/daemon'
import type { RuntimeAdapter, TurnContext, TurnResult } from '@agentchatme/agent-core/daemon'

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
//   * Tools are locked to `mcp__agentchat` (the messaging server only) with NO
//     --dangerously-skip-permissions: a daemon answering UNTRUSTED inbound must
//     not be able to run Bash/Write. Built-ins aren't in the allowlist, so a
//     headless turn simply can't call them (it does not hang).
//   * CLAUDE_CODE_* / CLAUDECODE env from a parent Claude session is stripped
//     so the child doesn't think it's a nested session.

const TURN_TIMEOUT_MS = 240_000

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

export class ClaudeAdapter implements RuntimeAdapter {
  readonly name = 'claude-code'
  // conversationId → true once we've created its session this process.
  private readonly started = new Set<string>()
  private mcpConfigPath = ''

  constructor(
    private readonly claudeConfigDir: string,
    private readonly identityHome: string,
    private readonly workdir: string,
  ) {}

  async preflight(): Promise<{ ok: boolean; detail?: string }> {
    const which = spawnSync('claude', ['--version'], { encoding: 'utf-8' })
    if (which.error) return { ok: false, detail: 'claude CLI not found on PATH' }
    if (!fs.existsSync(path.join(this.claudeConfigDir, '.credentials.json'))) {
      return {
        ok: false,
        detail: `claude is not logged in (no .credentials.json in ${this.claudeConfigDir})`,
      }
    }
    fs.mkdirSync(this.workdir, { recursive: true })
    // Write the MCP config the spawned turns load — the AgentChat messaging
    // server, pointed at THIS daemon's identity home (its credentials).
    this.mcpConfigPath = path.join(this.workdir, 'agentchat-mcp.json')
    fs.writeFileSync(
      this.mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          agentchat: {
            command: 'npx',
            args: ['-y', '@agentchatme/mcp'],
            env: { AGENTCHAT_HOME: this.identityHome },
          },
        },
      }),
    )
    return { ok: true }
  }

  async runTurn(ctx: TurnContext): Promise<TurnResult> {
    const uuid = sessionUuid(ctx.conversationId)
    const resume = this.started.has(ctx.conversationId)
    let result = await this.spawn(uuid, resume, ctx)
    // Restart recovery: we thought this was a first turn, but the session
    // already exists on disk from before a restart — resume it instead.
    if (!result.ok && !resume && /already in use/i.test(result.detail ?? '')) {
      log.info(`claude session for ${ctx.conversationId} exists on disk — resuming`)
      result = await this.spawn(uuid, true, ctx)
    }
    if (result.ok) this.started.add(ctx.conversationId)
    return result
  }

  private spawn(uuid: string, resume: boolean, ctx: TurnContext): Promise<TurnResult> {
    const sessionArgs = resume ? ['--resume', uuid] : ['--session-id', uuid]
    const args = [
      '-p',
      ...sessionArgs,
      '--mcp-config',
      this.mcpConfigPath,
      // Server-scoped allowlist: every agentchat messaging tool, and nothing
      // else. No --dangerously-skip-permissions — built-ins stay unavailable.
      '--allowedTools',
      'mcp__agentchat',
      '--output-format',
      'stream-json',
      '--verbose',
    ]

    const env = { ...process.env }
    for (const k of PARENT_ENV_KEYS) delete env[k]
    env['CLAUDE_CONFIG_DIR'] = this.claudeConfigDir

    return new Promise<TurnResult>((resolve) => {
      const child = spawn('claude', args, {
        cwd: this.workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
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
      })
      child.stderr.on('data', (d) => {
        stderr += d
      })

      // The prompt goes on stdin (see header) — write it and close.
      try {
        child.stdin.write(buildPrompt(ctx))
        child.stdin.end()
      } catch {
        /* stdin already gone; the child will exit and be handled below */
      }

      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve({ ok: false, detail: 'turn timed out' })
      }, TURN_TIMEOUT_MS)

      child.on('error', (err) => {
        clearTimeout(killTimer)
        resolve({ ok: false, fatal: true, detail: `claude spawn failed: ${String(err)}` })
      })

      child.on('close', (code) => {
        clearTimeout(killTimer)
        // We DISCARD the turn text — the reply (if any) went via the MCP send
        // tool. Success = clean exit AND the result event wasn't an error.
        if (code === 0 && isError !== true) {
          log.info(`claude turn done for ${ctx.conversationId} (sent=${sawSend})`)
          resolve({ ok: true, detail: sawSend ? 'replied' : 'silent' })
        } else {
          resolve({ ok: false, detail: `claude exited ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}` })
        }
      })
    })
  }
}

/** Deterministic, valid UUIDv5-shaped session id for a conversation, so a
 *  restart resumes the same claude session without tracking ids. Exported for
 *  tests — its determinism is what makes restart-resume work. */
export function sessionUuid(conversationId: string): string {
  const h = crypto.createHash('sha1').update(`agentchat-daemon:${conversationId}`).digest('hex')
  const variant = ((parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Exported for tests — the first-touch orientation string is the whole point
 *  of the enrichment, so it is worth pinning. */
export function buildPrompt(ctx: TurnContext): string {
  // First-touch orientation: WHEN it arrived, WHO sent it, WHERE (dm vs group),
  // and the body — enough for the turn to judge staleness and addressing before
  // it decides to reply. Full history/roster/attachments stay one
  // agentchat_get_conversation call away (by design — see adapters/types.ts).
  const where = describeConversation(ctx)
  const from = describeSender(ctx)
  const body = ctx.text
    ? `"${ctx.text}"`
    : `(a ${ctx.type ?? 'non-text'} message with no text body — read it with agentchat_get_conversation)`
  const lines = [
    `A new AgentChat message just arrived ${formatWhen(ctx.createdAt)} in ${where} from ${from}:`,
    body,
  ]
  if (ctx.conversationId.startsWith('grp_') && ctx.mentioned) {
    lines.push('You were @-mentioned in this message.')
  }
  lines.push(
    '',
    'Handle it exactly as your AgentChat etiquette directs: read the conversation',
    'first with agentchat_get_conversation, then reply via agentchat_send_message',
    'ONLY if a reply is genuinely warranted, or stay silent (do nothing) if it is',
    'not — an FYI, a thanks, or a closed thread gets silence. Do not narrate; just',
    'act. You are running unattended, so do not ask the human anything — if a reply',
    'would commit them to something, stay silent instead.',
  )
  return lines.join('\n')
}
