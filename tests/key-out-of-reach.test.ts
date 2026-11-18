import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import * as core from '@agentchatme/agent-core'
import { manualVersion, MANUAL } from '@agentchatme/agent-core'
import { VERSION } from '../src/version.js'
import { installFakeClaude, readArgvLog, type FakeClaude } from './helpers/fake-claude.js'

// ─── The key is on no command line and in no file but `credentials` ─────────
//
// Found in testing: every placement of the hosted MCP entry ran
// `claude mcp add … --header "Authorization: Bearer ac_…"`, so the live key
// sat on `claude`'s argv, readable with `ps` by any user of the machine, and
// in `~/.claude.json` and Claude Code's backups of it. And with another
// agent's key exported, `doctor --fix` registered THAT key for Claude Code.
//
// The entry now carries a `headersHelper`: a fixed script in the identity home
// that prints the Authorization header from `credentials` on each connection.
// These tests drive the publishable bundle against a fake `claude` that logs
// every argv it is started with.

const exec = promisify(execFile)
const BIN = path.join(__dirname, '..', 'dist', 'index.js')
const KEY = 'ac_live_' + 'k'.repeat(40)
const OTHER = 'ac_live_' + 'o'.repeat(40)
const BUNDLED = manualVersion(MANUAL)!

let sandbox: string
let fakeClaude: FakeClaude
let server: http.Server
let apiBase = ''
/** The handle `GET /v1/agents/me` answers, per key. */
const handles = new Map<string, string>()

const claudeDir = (): string => path.join(sandbox, '.claude')
const home = (): string => path.join(claudeDir(), 'agentchat')
const creds = (): string => path.join(home(), 'credentials')
const userStateText = (): string => fs.readFileSync(fakeClaude.relocatedUserState, 'utf-8')
const mcpEntry = (): Record<string, unknown> | undefined =>
  ((JSON.parse(userStateText()) as Record<string, unknown>)['mcpServers'] as Record<string, Record<string, unknown>> | undefined)?.['agentchat']
const CLIENT_HEADERS = { 'X-AgentChat-Client': 'claude-code', 'X-AgentChat-Client-Version': VERSION }

function texts(handle: string): Record<string, unknown> {
  return {
    version: '1',
    manual: { url: 'https://agentchat.me/skill.md', version: BUNDLED },
    wake_instruction: 'SERVED WAKE INSTRUCTION',
    invite_prompt: 'SERVED INVITE PROMPT',
    identity_line: `I am @${handle} on AgentChat (api.agentchat.me). Served for the test.`,
    identity_line_template: 'I am @<handle> on AgentChat (api.agentchat.me). Served for the test.',
  }
}

beforeEach(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-key-'))
  fs.mkdirSync(claudeDir(), { recursive: true })
  fakeClaude = installFakeClaude(sandbox)
  handles.clear()
  handles.set(KEY, 'claude-agent')
  handles.set(OTHER, 'someone-else')
  server = http.createServer((req, res) => {
    const auth = String(req.headers['authorization'] ?? '')
    const handle = handles.get(auth.replace(/^Bearer /, ''))
    res.setHeader('content-type', 'application/json')
    if (handle === undefined) {
      res.statusCode = 401
      res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Invalid API key' }))
      return
    }
    if (req.url?.startsWith('/v1/texts')) res.end(JSON.stringify(texts(handle)))
    else if (req.url === '/v1/agents/me') res.end(JSON.stringify({ handle, status: 'active' }))
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

function envFor(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fakeClaude.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
    HOME: sandbox,
    USERPROFILE: sandbox,
    CLAUDE_CONFIG_DIR: claudeDir(),
    AGENTCHAT_API_KEY: '',
    AGENTCHAT_API_BASE: apiBase,
    AGENTCHAT_LOG_LEVEL: 'silent',
    AGENTCHAT_SERVICE_DRY_RUN: '1',
    ...extra,
  }
}

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { env: envFor(env) })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** Run with `input` on stdin (`login --api-key -`). */
function runWithStdin(args: string[], input: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: envFor(env), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf-8')))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf-8')))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(input)
  })
}

function signIn(key = KEY, handle = 'claude-agent'): void {
  fs.mkdirSync(home(), { recursive: true })
  fs.writeFileSync(creds(), JSON.stringify({ api_key: key, handle, api_base: apiBase }), { mode: 0o600 })
}

/** Every argv `claude` was started with, as one string per invocation. */
function claudeArgv(): string[] {
  return readArgvLog(fakeClaude).map((argv) => argv.join(' '))
}

/** Run the entry's headersHelper the way Claude Code does: through a shell, in the config directory. */
function runHelper(env: NodeJS.ProcessEnv = {}): Record<string, unknown> {
  const command = mcpEntry()?.['headersHelper']
  expect(typeof command).toBe('string')
  const result = spawnSync(command as string, { shell: true, cwd: claudeDir(), encoding: 'utf-8', env: { ...process.env, ...env } })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

describe('the hosted MCP entry is placed without the key', () => {
  it('install: the entry holds the client headers and a headers helper, never the key; no claude command line held it', { timeout: 30_000 }, async () => {
    signIn()
    const out = await run([])
    expect(out.code, out.stdout + out.stderr).toBe(0)

    const entry = mcpEntry()
    expect(entry).toMatchObject({ type: 'http', url: `${apiBase}/mcp`, headers: CLIENT_HEADERS })
    expect(Object.keys(entry!['headers'] as object)).not.toContain('Authorization')
    expect(userStateText()).not.toContain(KEY)
    expect(claudeArgv().some((argv) => argv.startsWith('mcp add-json --scope user agentchat'))).toBe(true)
    for (const argv of claudeArgv()) expect(argv).not.toContain(KEY)
    expect(out.stdout + out.stderr).not.toContain(KEY)
    expect(out.stdout).toContain(`the key stays in ${creds()}`)

    // What Claude Code sends: the helper's answer, from the credentials file.
    expect(runHelper()).toEqual({ Authorization: `Bearer ${KEY}` })
    // The helper reads no environment variable: an exported key changes nothing.
    expect(runHelper({ AGENTCHAT_API_KEY: OTHER })).toEqual({ Authorization: `Bearer ${KEY}` })
    // Owner-only, like everything in the identity home.
    if (process.platform !== 'win32') expect(fs.statSync(path.join(home(), 'bin', 'mcp-headers.mjs')).mode & 0o777).toBe(0o600)

    // Converges: a second install changes nothing and calls no `mcp add-json`.
    const calls = claudeArgv().length
    const again = await run([])
    expect(again.code, again.stdout).toBe(0)
    expect(again.stdout).toContain('✓ mcp: hosted tools registered')
    expect(claudeArgv().slice(calls).filter((a) => a.startsWith('mcp '))).toEqual([])
  })

  it('login with the key on stdin: the key reaches credentials and no command line', { timeout: 30_000 }, async () => {
    expect((await run([])).code).toBe(0) // installed, no identity yet
    const out = await runWithStdin(['login', '--api-key', '-'], `${KEY}\n`)
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(JSON.parse(fs.readFileSync(creds(), 'utf-8'))).toMatchObject({ api_key: KEY, handle: 'claude-agent' })
    for (const argv of claudeArgv()) expect(argv).not.toContain(KEY)
    expect(userStateText()).not.toContain(KEY)
    expect(runHelper()).toEqual({ Authorization: `Bearer ${KEY}` })
  })

  it('a new key needs no re-registration: the helper answers with it on the next connection', { timeout: 30_000 }, async () => {
    signIn()
    expect((await run([])).code).toBe(0)
    const rotated = 'ac_live_' + 'r'.repeat(40)
    handles.set(rotated, 'claude-agent')
    signIn(rotated)
    const calls = claudeArgv().length

    expect(runHelper()).toEqual({ Authorization: `Bearer ${rotated}` })
    const doctor = await run(['doctor'])
    expect(doctor.stdout).toContain('PASS hosted-mcp:')
    expect(claudeArgv().slice(calls).filter((a) => a.startsWith('mcp add'))).toEqual([])
  })

  it('logout removes the entry by its helper, even under a URL that moved', { timeout: 30_000 }, async () => {
    signIn()
    expect((await run([])).code).toBe(0)
    const doc = JSON.parse(userStateText()) as { mcpServers: Record<string, Record<string, unknown>> }
    doc.mcpServers['agentchat']!['url'] = 'http://moved.example/mcp'
    fs.writeFileSync(fakeClaude.relocatedUserState, JSON.stringify(doc))

    const out = await run(['logout'])
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(mcpEntry()).toBeUndefined()
  })

  it('uninstall removes the entry and the helper', { timeout: 30_000 }, async () => {
    signIn()
    expect((await run([])).code).toBe(0)
    expect(fs.existsSync(path.join(home(), 'bin', 'mcp-headers.mjs'))).toBe(true)
    const out = await run(['uninstall'])
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(mcpEntry()).toBeUndefined()
    expect(fs.existsSync(path.join(home(), 'bin', 'mcp-headers.mjs'))).toBe(false)
  })

  it('a helper whose Node is gone is said by status and re-pointed by doctor --fix', { timeout: 30_000 }, async () => {
    signIn()
    expect((await run([])).code).toBe(0)
    const doc = JSON.parse(userStateText()) as { mcpServers: Record<string, Record<string, unknown>> }
    const gone = path.join(sandbox, 'no-such-node', process.platform === 'win32' ? 'node.exe' : 'node')
    const script = path.join(home(), 'bin', 'mcp-headers.mjs')
    doc.mcpServers['agentchat']!['headersHelper'] = process.platform === 'win32' ? `"${gone}" "${script}"` : `'${gone}' '${script}'`
    fs.writeFileSync(fakeClaude.relocatedUserState, JSON.stringify(doc))

    expect((await run(['status'])).stdout).toContain('asks a headers helper that is out of date or whose Node is gone')
    const fixed = await run(['doctor', '--fix'])
    expect(fixed.stdout).toContain('PASS hosted-mcp:')
    expect(runHelper()).toEqual({ Authorization: `Bearer ${KEY}` })
  })
})

describe('an entry an earlier release placed with the key in it', () => {
  const legacy = (): string =>
    JSON.stringify({ numStartups: 7, mcpServers: { other: { type: 'stdio', command: 'x' }, agentchat: { type: 'http', url: `${apiBase}/mcp`, headers: { Authorization: `Bearer ${KEY}`, ...CLIENT_HEADERS } } } })

  it('status says the key is in ~/.claude.json; install takes it out, keeps the rest of the file, and says where copies may remain', { timeout: 30_000 }, async () => {
    signIn()
    fs.writeFileSync(fakeClaude.relocatedUserState, legacy())
    expect((await run(['status'])).stdout).toContain(`holds this agent's key in ${fakeClaude.relocatedUserState}`)

    const out = await run([])
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toContain(`the key an earlier release wrote into ${fakeClaude.relocatedUserState} is taken out of it`)
    expect(out.stdout).toContain(path.join(claudeDir(), 'backups'))
    expect(userStateText()).not.toContain(KEY)
    const doc = JSON.parse(userStateText()) as { numStartups: number; mcpServers: Record<string, unknown> }
    expect(doc.numStartups).toBe(7)
    expect(doc.mcpServers['other']).toEqual({ type: 'stdio', command: 'x' })
    expect(runHelper()).toEqual({ Authorization: `Bearer ${KEY}` })
    for (const argv of claudeArgv()) expect(argv).not.toContain(KEY)
  })

  it('doctor --fix does the same', { timeout: 30_000 }, async () => {
    signIn()
    fs.writeFileSync(fakeClaude.relocatedUserState, legacy())
    const out = await run(['doctor', '--fix'])
    expect(out.stdout).toContain('PASS hosted-mcp:')
    expect(userStateText()).not.toContain(KEY)
  })
})

describe('another agent’s key exported in the shell', () => {
  it('doctor --fix places nothing of it: the entry, its helper and every command line stay this home’s', { timeout: 30_000 }, async () => {
    signIn()
    fs.writeFileSync(fakeClaude.relocatedUserState, JSON.stringify({ mcpServers: { agentchat: { type: 'http', url: `${apiBase}/mcp`, headers: { Authorization: `Bearer ${KEY}` } } } }))

    const out = await run(['doctor', '--fix'], { AGENTCHAT_API_KEY: OTHER })

    expect(userStateText()).not.toContain(OTHER)
    for (const argv of claudeArgv()) expect(argv).not.toContain(OTHER)
    expect(runHelper({ AGENTCHAT_API_KEY: OTHER })).toEqual({ Authorization: `Bearer ${KEY}` })
    expect(out.stdout + out.stderr).not.toContain(OTHER)
    expect(JSON.parse(fs.readFileSync(creds(), 'utf-8'))).toMatchObject({ api_key: KEY })
  })

  it('install with it exported registers this home’s agent', { timeout: 30_000 }, async () => {
    signIn()
    const out = await run([], { AGENTCHAT_API_KEY: OTHER })
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toContain('Connected as @claude-agent')
    expect(userStateText()).not.toContain(OTHER)
    expect(runHelper()).toEqual({ Authorization: `Bearer ${KEY}` })
  })
})

// The engine's refusals in words (status, doctor's env-key check, login not
// adopting the exported key) come with the agent-core release after 0.5.2.
// These run once the pin moves there, and stop a release on an engine that
// lacks them.
const ENGINE_REFUSES = 'envKeyConflict' in core

describe.skipIf(!ENGINE_REFUSES)('the engine refuses another agent’s exported key in words', () => {
  it('login without --api-key does not adopt it; status refuses; nothing of it is written', { timeout: 30_000 }, async () => {
    signIn()
    expect((await run([])).code).toBe(0)
    const login = await runWithStdin(['login'], '', { AGENTCHAT_API_KEY: OTHER })
    expect(login.code).toBe(1)
    expect(login.stderr).toContain('AGENTCHAT_API_KEY is exported')
    const status = await run(['status'], { AGENTCHAT_API_KEY: OTHER })
    expect(status.code).toBe(1)
    expect(status.stderr).toContain('AGENTCHAT_API_KEY is exported')
    expect((await run(['doctor'], { AGENTCHAT_API_KEY: OTHER })).stdout).toMatch(/FAIL env-key:/)
    expect(JSON.parse(fs.readFileSync(creds(), 'utf-8'))).toMatchObject({ api_key: KEY })
    expect(userStateText()).not.toContain(OTHER)
  })
})

describe('no printed step puts a key on a command line', () => {
  it('--help names login with the key on stdin or a prompt, never a key argument or an exported key', async () => {
    const out = await run(['--help'])
    expect(out.stdout).toContain('login --api-key -')
    expect(out.stdout).not.toMatch(/--api-key <ac_|AGENTCHAT_API_KEY=/)
    expect(out.stdout).not.toMatch(/AGENTCHAT_API_KEY[^\n]*override/)
  })
})
