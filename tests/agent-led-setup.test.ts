import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { MANUAL, manualVersion } from '@agentchatme/agent-core'
import { installFakeClaude, type FakeClaude } from './helpers/fake-claude.js'
import { VERSION } from '../src/version.js'

// ─── An agent can do the whole setup itself ────────────────────────────────
//
// The built CLI, a local server, a fake `claude`, the service manager left
// out (AGENTCHAT_SERVICE_DRY_RUN=1: the service definition is written into
// the sandbox, nothing is registered). `login --api-key -` used to place the
// key, the tools and the identity line and no listener: the agent was deaf,
// and the output said "the integration daemon follows the credential on its
// own". Now every account command registers the listener (unless the person
// switched it off) and ends with the setup verdict.

const BIN = path.join(__dirname, '..', 'dist', 'index.js')
const KEY = 'ac_live_' + 's'.repeat(40)
const BUNDLED = manualVersion(MANUAL)!

let sandbox: string
let fake: FakeClaude
let server: http.Server
let apiBase = ''
/** X-AgentChat-Platform of every request the server saw. */
let platforms: string[] = []

const claudeDir = (): string => path.join(sandbox, '.claude')
const home = (): string => path.join(claudeDir(), 'agentchat')
const userState = (): string => path.join(claudeDir(), '.claude.json')
const line = (handle: string): string => `I am @${handle} on AgentChat (api.agentchat.me). Served for the setup test.`

beforeEach(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-setup-'))
  fs.mkdirSync(claudeDir(), { recursive: true })
  fake = installFakeClaude(sandbox)
  platforms = []
  server = http.createServer((req, res) => {
    platforms.push(String(req.headers['x-agentchat-platform'] ?? ''))
    res.setHeader('content-type', 'application/json')
    if (String(req.headers['authorization'] ?? '') !== `Bearer ${KEY}`) {
      res.statusCode = 401
      res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Invalid API key' }))
      return
    }
    if (req.url?.startsWith('/v1/texts')) {
      res.end(
        JSON.stringify({
          version: '1',
          manual: { url: 'https://agentchat.me/skill.md', version: BUNDLED },
          wake_instruction: 'SERVED WAKE INSTRUCTION',
          invite_prompt: 'SERVED INVITE PROMPT',
          identity_line: line('claude-agent'),
          identity_line_template: line('<handle>'),
        }),
      )
    } else if (req.url === '/v1/agents/me') res.end(JSON.stringify({ handle: 'claude-agent', status: 'active' }))
    else {
      res.statusCode = 404
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not here' }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function run(args: string[], input = '', extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        PATH: `${fake.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        HOME: sandbox,
        USERPROFILE: sandbox,
        CLAUDE_CONFIG_DIR: claudeDir(),
        AGENTCHAT_API_KEY: '',
        AGENTCHAT_API_BASE: apiBase,
        AGENTCHAT_LOG_LEVEL: 'silent',
        AGENTCHAT_SERVICE_DRY_RUN: '1',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf-8')))
    child.stderr.on('data', (c: Buffer) => (out += c.toString('utf-8')))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
    child.stdin.end(input)
  })
}
const login = () => run(['login', '--api-key', '-'], `${KEY}\n`)
const lastLine = (out: string): string => out.trimEnd().split('\n').pop() ?? ''

describe('login leaves a listening agent, with nothing installed before (the hosted-tools sign-up path)', () => {
  it('registers the listener service and ends with the setup verdict; the key is never printed', { timeout: 60_000 }, async () => {
    const out = await login()
    expect(out.code, out.out).toBe(0)
    expect(fs.existsSync(path.join(home(), 'always-on.wanted'))).toBe(true)
    expect(fs.readFileSync(path.join(home(), 'always-on.installed-version'), 'utf-8').trim()).toBe(VERSION)
    expect(fs.existsSync(path.join(home(), 'bin', 'agentchat-daemon.mjs'))).toBe(true)
    expect(out.out).toMatch(/ {2}listener: registered \(agentchatd-claude-code/)
    expect(out.out).not.toContain('follows the credential on its own')
    // A dry run starts no daemon: the verdict says it is coming up, and what to run next.
    expect(lastLine(out.out)).toMatch(/^Setup: listener_starting — the listener is connecting as @claude-agent\. Wait 10 s, then run `npx -y @agentchatme\/claude-code status`/)
    expect(out.out).not.toContain(KEY)

    const status = await run(['status', '--json'])
    const parsed = JSON.parse(lastLine(status.out)) as { setup: { state: string; command: string } }
    expect(parsed.setup).toMatchObject({ state: 'listener_starting', command: 'npx -y @agentchatme/claude-code status' })
  })

  it('after uninstall (the person’s opt-out) login places the key and tools but not the listener, and asks the person', { timeout: 60_000 }, async () => {
    expect((await login()).code).toBe(0)
    expect((await run(['uninstall'])).code).toBe(0)
    const back = await login()
    expect(back.code, back.out).toBe(0)
    expect(fs.existsSync(path.join(home(), 'always-on.wanted'))).toBe(false)
    expect(back.out).toContain('  listener: off — switched off by the person you work with')
    expect(lastLine(back.out)).toMatch(/^Setup: listener_off — .*run `npx -y @agentchatme\/claude-code daemon install`\.$/)
  })

  it('never downgrades a service a newer release registered', { timeout: 60_000 }, async () => {
    expect((await login()).code).toBe(0)
    fs.writeFileSync(path.join(home(), 'always-on.installed-version'), '99.0.0\n')
    const again = await login()
    expect(again.code, again.out).toBe(0)
    expect(again.out).toContain('a newer release (99.0.0) registered it, left as it is')
    expect(fs.readFileSync(path.join(home(), 'always-on.installed-version'), 'utf-8').trim()).toBe('99.0.0')
  })

  it('doctor --fix registers a listener that is missing', { timeout: 60_000 }, async () => {
    expect((await login()).code).toBe(0)
    fs.rmSync(path.join(home(), 'always-on.wanted'))
    fs.rmSync(path.join(home(), 'always-on.installed-version'))
    const fix = await run(['doctor', '--fix'])
    expect(fix.out).toContain('PASS listener: registered (agentchatd-claude-code')
    expect(fs.existsSync(path.join(home(), 'always-on.wanted'))).toBe(true)
  })
})

describe('the hosted tools in the way: an "agentchat" MCP entry this integration did not write', () => {
  it('login leaves it alone, registers no listener over it, and the verdict asks the person before touching their entry', { timeout: 60_000 }, async () => {
    fs.writeFileSync(userState(), JSON.stringify({ mcpServers: { agentchat: { type: 'http', url: 'https://example.com/someone-elses-mcp' } } }))
    const out = await login()
    expect(out.code, out.out).toBe(0)
    expect(JSON.parse(fs.readFileSync(userState(), 'utf-8')).mcpServers.agentchat.url).toBe('https://example.com/someone-elses-mcp')
    expect(fs.existsSync(path.join(home(), 'always-on.wanted'))).toBe(false)
    expect(out.out).toContain('  listener: not registered until the AgentChat tools are in place (below)')
    const verdict = lastLine(out.out)
    expect(verdict).toMatch(/^Setup: tools_missing — the hosted AgentChat tools are not set up for Claude Code: /)
    expect(verdict).toContain("It is the person's own entry: never change it without asking the person you work with.")
    expect(verdict).toContain('If they agree, run `claude mcp remove --scope user agentchat`, then `npx -y @agentchatme/claude-code doctor --fix`.')

    const status = await run(['status', '--json'])
    expect((JSON.parse(lastLine(status.out)) as { setup: { state: string; needs_person: boolean; command: string | null } }).setup).toMatchObject({
      state: 'tools_missing',
      needs_person: true,
      command: null,
    })
  })
})

describe('install ends with the verdict, not a checklist for a person', () => {
  it('without an account: how to create one, and how to sign in with a key from a file', { timeout: 60_000 }, async () => {
    const out = await run([])
    expect(out.code, out.out).toBe(0)
    expect(out.out).not.toContain('Next:')
    expect(lastLine(out.out)).toMatch(/^Setup: no_account — .*`npx -y @agentchatme\/claude-code register --email <email> --handle <handle>`.*`npx -y @agentchatme\/claude-code login --api-key - < <that file>`/)
  })
})

describe('every request names the host and the install', () => {
  it('the runtime version and the install id of the home ride on every request; AGENTCHAT_TELEMETRY=off makes and sends no install id', { timeout: 60_000 }, async () => {
    expect((await login()).code).toBe(0)
    const id = fs.readFileSync(path.join(home(), 'install-id'), 'utf-8').trim()
    expect(id).toMatch(/^ins_[A-Za-z0-9_-]{22}$/)
    expect(platforms.length).toBeGreaterThan(0)
    for (const platform of platforms) {
      expect(platform).toContain('host="claude-code/2.1.316"')
      expect(platform).toContain(`install="${id}"`)
    }
    // Kept for the daemon, which names it without running --version.
    expect(fs.readFileSync(path.join(home(), 'runtime-host'), 'utf-8').trim()).toBe('claude-code/2.1.316')

    fs.rmSync(path.join(home(), 'install-id'))
    platforms = []
    expect((await run(['status'], '', { AGENTCHAT_TELEMETRY: 'off' })).code).toBe(0)
    expect(fs.existsSync(path.join(home(), 'install-id'))).toBe(false)
    for (const platform of platforms) expect(platform).not.toContain('install=')
  })
})
