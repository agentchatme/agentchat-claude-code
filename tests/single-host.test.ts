import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { MANUAL, IDENTITY_LINE_TEMPLATE } from '@agentchatme/agent-core'
import { installFakeClaude, type FakeClaude } from './helpers/fake-claude.js'

const exec = promisify(execFile)
// Drives the publishable NPX bundle — the exact file users run.
const BIN = path.join(__dirname, '..', 'dist', 'index.js')

// ─── Placement, through the CLI, against a fake Claude Code ─────────────────
//
// The host is a compile-time fact of this package: no `--platform`, no host
// detection, no branch that could resolve another agent's home. A fully set-up
// Codex agent shares the sandbox and must be byte-identical after every command.

let sandbox: string
let fakeClaude: FakeClaude
const KEY = 'ac_live_' + 'a'.repeat(40)

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-integration-'))
  fs.mkdirSync(path.join(sandbox, '.claude'), { recursive: true })
  fakeClaude = installFakeClaude(sandbox)
  fs.mkdirSync(path.join(sandbox, '.codex', 'agentchat'), { recursive: true })
  fs.writeFileSync(path.join(sandbox, '.codex', 'agentchat', 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'c'.repeat(40), handle: 'codex-agent' }))
  fs.writeFileSync(path.join(sandbox, '.codex', 'AGENTS.md'), '<!-- agentchat:start -->\nI am @codex-agent on AgentChat (api.agentchat.me).\n<!-- agentchat:end -->\n')
  fs.writeFileSync(path.join(sandbox, '.codex', 'config.toml'), '[model]\nname = "o4"\n\n# agentchat:start\n[mcp_servers.agentchat]\n# agentchat:end\n')
})
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else out[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  walk(dir)
  return out
}

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        PATH: `${fakeClaude.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        HOME: sandbox,
        USERPROFILE: sandbox,
        CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude'),
        CODEX_HOME: path.join(sandbox, '.codex'),
        AGENTCHAT_API_KEY: '',
        AGENTCHAT_API_BASE: 'http://127.0.0.1:9',
        AGENTCHAT_LOG_LEVEL: 'silent',
        AGENTCHAT_SERVICE_DRY_RUN: '1',
        ...env,
      },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

const codexDir = (): string => path.join(sandbox, '.codex')
const home = (): string => path.join(sandbox, '.claude', 'agentchat')
const creds = (): string => path.join(home(), 'credentials')
const claudeMd = (): string => path.join(sandbox, '.claude', 'CLAUDE.md')
const skill = (): string => path.join(sandbox, '.claude', 'skills', 'agentchat', 'SKILL.md')
const userState = (): Record<string, unknown> => JSON.parse(fs.readFileSync(fakeClaude.relocatedUserState, 'utf-8')) as Record<string, unknown>
const mcpEntry = (): Record<string, unknown> | undefined => (userState()['mcpServers'] as Record<string, Record<string, unknown>> | undefined)?.['agentchat']

function giveClaudeAnIdentity(): void {
  fs.mkdirSync(home(), { recursive: true })
  fs.writeFileSync(creds(), JSON.stringify({ api_key: KEY, handle: 'claude-agent', api_base: 'http://127.0.0.1:9' }))
}

describe('install places the four texts', () => {
  it('without an identity: the manual as a skill, the setup offer in CLAUDE.md, no MCP entry (no key yet), the service registered', async () => {
    const out = await run([])
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(fs.readFileSync(skill(), 'utf-8')).toBe(MANUAL)
    const md = fs.readFileSync(claudeMd(), 'utf-8')
    expect(md).toContain('this agent has no account yet')
    expect(md).toContain('register --email <email> --handle <handle>')
    expect(fs.existsSync(fakeClaude.relocatedUserState)).toBe(false)
    expect(fs.existsSync(path.join(home(), 'always-on.wanted'))).toBe(true)
    expect(fs.existsSync(path.join(home(), 'bin', 'agentchat-daemon.mjs'))).toBe(true)
    expect(out.stdout).toContain('Ask Claude Code: "Set up your AgentChat account."')
    expect(out.stdout).toContain('✓ skill:')
    expect(out.stdout).toContain('✓ service:')
  })

  it('with an identity: the hosted MCP server at user scope with the key, the identity line, the skill', async () => {
    giveClaudeAnIdentity()
    const out = await run([])
    expect(out.code, out.stdout + out.stderr).toBe(0)

    expect(mcpEntry()).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: `Bearer ${KEY}` },
    })
    if (process.platform !== 'win32') expect(fs.statSync(fakeClaude.relocatedUserState).mode & 0o777).toBe(0o600)

    const md = fs.readFileSync(claudeMd(), 'utf-8')
    expect(md).toContain(IDENTITY_LINE_TEMPLATE.split('<handle>').join('claude-agent'))
    expect(md).not.toContain('no account yet')
    expect(fs.readFileSync(skill(), 'utf-8')).toBe(MANUAL)
    expect(out.stdout).toContain('Connected as @claude-agent')
    // Re-running converges: no second entry, no second block, exit 0.
    const again = await run([])
    expect(again.code, again.stdout).toBe(0)
    expect(fs.readFileSync(claudeMd(), 'utf-8').split('<!-- agentchat:start -->')).toHaveLength(2)
    expect(again.stdout).toContain('✓ mcp: hosted tools registered')
  })

  it('honours CLAUDE_CONFIG_DIR: everything lands under the relocated directory, nothing under ~/.claude', async () => {
    const relocated = path.join(sandbox, 'relocated-claude')
    fs.mkdirSync(path.join(relocated, 'agentchat'), { recursive: true })
    fs.writeFileSync(path.join(relocated, 'agentchat', 'credentials'), JSON.stringify({ api_key: KEY, handle: 'moved-agent', api_base: 'http://127.0.0.1:9' }))
    const out = await run([], { CLAUDE_CONFIG_DIR: relocated })
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(fs.existsSync(path.join(relocated, 'skills', 'agentchat', 'SKILL.md'))).toBe(true)
    expect(fs.readFileSync(path.join(relocated, 'CLAUDE.md'), 'utf-8')).toContain('@moved-agent')
    const state = JSON.parse(fs.readFileSync(path.join(relocated, '.claude.json'), 'utf-8')) as { mcpServers: Record<string, unknown> }
    expect(state.mcpServers['agentchat']).toBeDefined()
    expect(fs.existsSync(skill())).toBe(false)
    expect(fs.existsSync(fakeClaude.relocatedUserState)).toBe(false)
  })

  it('refuses a Claude Code older than the floor (2.1.274), placing nothing', async () => {
    fakeClaude = installFakeClaude(sandbox, '2.1.273')
    const out = await run([])
    expect(out.code).toBe(1)
    expect(out.stdout).toContain('requires Claude Code >= 2.1.274')
    expect(fs.existsSync(skill())).toBe(false)
  })

  it('refuses to replace a foreign user MCP server named agentchat', async () => {
    giveClaudeAnIdentity()
    fs.writeFileSync(fakeClaude.relocatedUserState, JSON.stringify({ mcpServers: { agentchat: { type: 'http', url: 'https://someone-else.example/mcp' } } }))
    const out = await run([])
    expect(out.code).toBe(1)
    expect(out.stdout).toContain('left untouched')
    expect(mcpEntry()).toEqual({ type: 'http', url: 'https://someone-else.example/mcp' })
  })

  it('does not undo an explicit daemon disable during an upgrade', async () => {
    expect((await run([])).code).toBe(0)
    expect((await run(['daemon', 'disable'])).code).toBe(0)
    const upgraded = await run([])
    expect(upgraded.code, upgraded.stdout).toBe(0)
    expect(upgraded.stdout).toContain('○ service: doorbell daemon off (your choice')
    expect(fs.existsSync(path.join(home(), 'always-on.optout'))).toBe(true)
  })
})

describe('upgrading from the pre-doorbell release', () => {
  it('removes the four lifecycle hooks, the stdio mcp-proxy entry, the stable bundle and the old manual — and keeps the user’s own hooks', async () => {
    giveClaudeAnIdentity()
    const stable = path.join(home(), 'bin', 'agentchat.mjs')
    fs.mkdirSync(path.dirname(stable), { recursive: true })
    fs.writeFileSync(stable, '// old bundle')
    fs.writeFileSync(path.join(home(), 'SKILL.md'), '# old rendered manual')
    const ours = (sub: string) => ({ hooks: [{ type: 'command', command: 'node', args: [stable, 'hook', sub], timeout: 20 }] })
    fs.writeFileSync(
      path.join(sandbox, '.claude', 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        hooks: {
          SessionStart: [{ matcher: 'startup|resume|clear|fork', ...ours('session-start') }],
          UserPromptSubmit: [ours('user-prompt')],
          Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }, ...ours('stop').hooks] }],
          SessionEnd: [ours('session-end')],
        },
      }),
    )
    fs.writeFileSync(fakeClaude.relocatedUserState, JSON.stringify({ preserved: 'yes', mcpServers: { other: { type: 'stdio', command: 'other-server', args: [], env: {} }, agentchat: { type: 'stdio', command: 'node', args: [stable, 'mcp-proxy'], env: {} } } }))

    const out = await run([])
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toContain('lifecycle hooks removed')

    const settings = JSON.parse(fs.readFileSync(path.join(sandbox, '.claude', 'settings.json'), 'utf-8')) as { theme: string; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(settings.theme).toBe('dark')
    expect(Object.keys(settings.hooks)).toEqual(['Stop'])
    expect(settings.hooks['Stop']).toEqual([{ hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }] }])

    const state = userState() as { preserved: string; mcpServers: Record<string, Record<string, unknown>> }
    expect(state.preserved).toBe('yes')
    expect(state.mcpServers['other']?.['command']).toBe('other-server')
    expect(state.mcpServers['agentchat']).toMatchObject({ type: 'http', url: 'http://127.0.0.1:9/mcp' })
    expect(fs.existsSync(stable)).toBe(false)
    expect(fs.existsSync(path.join(home(), 'SKILL.md'))).toBe(false)
    expect(fs.readFileSync(skill(), 'utf-8')).toBe(MANUAL)
  })
})

describe('there is no way to address another agent', () => {
  it('--platform is not a recognised option at all', async () => {
    const out = await run(['status', '--platform', 'codex'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain("Unknown option '--platform'")
  })

  it('logout removes the credential, the identity line and the key from Claude Code — and only for this agent', async () => {
    giveClaudeAnIdentity()
    expect((await run([])).code).toBe(0)
    const before = snapshot(codexDir())

    const out = await run(['logout'])
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(snapshot(codexDir())).toEqual(before)
    expect(fs.existsSync(creds())).toBe(false)
    expect(mcpEntry()).toBeUndefined()
    const md = fs.readFileSync(claudeMd(), 'utf-8')
    expect(md).not.toContain('@claude-agent')
    expect(md).toContain('no account yet') // the offer is back
    expect(fs.existsSync(skill())).toBe(true) // the manual stays installed
    expect(out.stdout).toContain('key is no longer registered')
  })

  it('logout under a non-default api_base still removes the MCP entry: the pre-clear identity names the server', async () => {
    // The hole: credentials cleared first, base guessed afterwards → the entry
    // at the real base looked foreign and the key stayed in .claude.json.
    giveClaudeAnIdentity() // api_base http://127.0.0.1:9 in the FILE, nothing in the environment
    expect((await run([], { AGENTCHAT_API_BASE: '' })).code).toBe(0)
    expect(mcpEntry()).toMatchObject({ url: 'http://127.0.0.1:9/mcp' })

    const out = await run(['logout'], { AGENTCHAT_API_BASE: '' })
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(mcpEntry()).toBeUndefined()
    expect(out.stdout).toContain('key is no longer registered')
  })

  it('logout recognises our entry by the key when the URL differs, and leaves a true foreign entry alone', async () => {
    giveClaudeAnIdentity()
    fs.writeFileSync(
      fakeClaude.relocatedUserState,
      JSON.stringify({ mcpServers: { agentchat: { type: 'http', url: 'http://moved.example/mcp', headers: { Authorization: `Bearer ${KEY}` } } } }),
    )
    expect((await run(['logout'])).code).toBe(0)
    expect(mcpEntry()).toBeUndefined()

    giveClaudeAnIdentity()
    fs.writeFileSync(
      fakeClaude.relocatedUserState,
      JSON.stringify({ mcpServers: { agentchat: { type: 'http', url: 'http://someone-else.example/mcp', headers: { Authorization: 'Bearer other' } } } }),
    )
    const out = await run(['logout'])
    expect(out.code).toBe(0)
    expect(mcpEntry()).toMatchObject({ url: 'http://someone-else.example/mcp' })
    expect(out.stdout).toContain('left untouched')
  })

  it('uninstall under a non-default api_base removes the MCP entry too', async () => {
    giveClaudeAnIdentity()
    expect((await run([], { AGENTCHAT_API_BASE: '' })).code).toBe(0)
    const out = await run(['uninstall'], { AGENTCHAT_API_BASE: '' })
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(mcpEntry()).toBeUndefined()
    expect(fs.existsSync(creds())).toBe(true)
  })

  it('uninstall removes the integration and preserves the identity file', async () => {
    giveClaudeAnIdentity()
    expect((await run([])).code).toBe(0)
    const before = snapshot(codexDir())

    const out = await run(['uninstall'])
    expect(out.code, out.stdout + out.stderr).toBe(0)
    expect(fs.existsSync(creds())).toBe(true)
    expect(fs.existsSync(path.join(home(), 'always-on.optout'))).toBe(true)
    expect(fs.existsSync(path.join(home(), 'bin', 'agentchat-daemon.mjs'))).toBe(false)
    expect(mcpEntry()).toBeUndefined()
    expect(fs.existsSync(skill())).toBe(false)
    expect(fs.readFileSync(claudeMd(), 'utf-8')).not.toContain('agentchat:start')
    expect(snapshot(codexDir())).toEqual(before)
  })

  it('points at the OTHER agent’s front door rather than offering to do it', async () => {
    const out = await run(['--help'])
    expect(out.stdout).toContain('npx -y @agentchatme/codex')
    expect(out.stdout.toLowerCase()).toContain('separate agentchat agent')
  })

  it('keeps the user’s own CLAUDE.md content throughout', async () => {
    fs.writeFileSync(claudeMd(), '# My notes\n')
    giveClaudeAnIdentity()
    await run([])
    await run(['logout'])
    await run(['uninstall'])
    expect(fs.readFileSync(claudeMd(), 'utf-8')).toBe('# My notes\n')
  })
})

describe('doctor', () => {
  it('reports the missing identity before registration, and the placement that exists', { timeout: 30_000 }, async () => {
    await run([])
    const out = await run(['doctor'])
    expect(out.stdout).toContain('FAIL credentials')
    expect(out.stdout).toContain('PASS skill')
    expect(out.stdout).toContain('WARN hosted-mcp')
  })

  it('detects an identity line naming a different agent, and --fix repairs it', { timeout: 30_000 }, async () => {
    giveClaudeAnIdentity()
    await run([])
    // Exactly the corruption the old shared CLI produced on a two-agent box.
    fs.writeFileSync(claudeMd(), '<!-- agentchat:start -->\nI am @codex-agent on AgentChat (api.agentchat.me).\n<!-- agentchat:end -->\n')
    const before = snapshot(codexDir())

    const seen = await run(['doctor'])
    expect(seen.stdout).toContain('says @codex-agent but this agent is @claude-agent')

    const fixed = await run(['doctor', '--fix'])
    expect(fixed.stdout).toContain('repaired → @claude-agent')
    const md = fs.readFileSync(claudeMd(), 'utf-8')
    expect(md).toContain('I am @claude-agent on AgentChat')
    expect(md).not.toContain('@codex-agent')
    expect(snapshot(codexDir())).toEqual(before)
  })

  it('refreshes an identity line from an older release', { timeout: 30_000 }, async () => {
    giveClaudeAnIdentity()
    await run([])
    fs.writeFileSync(claudeMd(), '<!-- agentchat:start -->\nYou are **@claude-agent** on AgentChat.\n<!-- agentchat:end -->\n')
    const seen = await run(['doctor'])
    expect(seen.stdout).toContain('carries an older identity text')
    await run(['doctor', '--fix'])
    expect(fs.readFileSync(claudeMd(), 'utf-8')).toContain('I am @claude-agent on AgentChat')
  })

  it('re-registers the hosted MCP entry when the key changed', { timeout: 30_000 }, async () => {
    giveClaudeAnIdentity()
    await run([])
    const rotated = 'ac_live_' + 'r'.repeat(40)
    fs.writeFileSync(creds(), JSON.stringify({ api_key: rotated, handle: 'claude-agent', api_base: 'http://127.0.0.1:9' }))
    const seen = await run(['doctor'])
    expect(seen.stdout).toContain('carries a different key')
    const fixed = await run(['doctor', '--fix'])
    expect(fixed.stdout).toContain('PASS hosted-mcp:')
    expect(mcpEntry()).toMatchObject({ headers: { Authorization: `Bearer ${rotated}` } })
  })
})

describe('every hint is a runnable command', () => {
  for (const argv of [[], ['--help'], ['status'], ['doctor'], ['logout'], ['daemon', 'status']]) {
    it(`\`${argv.join(' ') || '(bare)'}\` renders no un-interpolated placeholder`, { timeout: 30_000 }, async () => {
      const out = await run(argv)
      expect(out.stdout + out.stderr).not.toContain('${')
    })
  }
})

describe('the publishable bundle runs after its NPX cache is gone', () => {
  it('has no external imports left to resolve', () => {
    const bundle = fs.readFileSync(BIN, 'utf-8')
    expect(bundle).not.toMatch(/^import .* from ["'](agentchatme|@agentchatme\/|zod)/m)
  })

  it('executes when copied somewhere with no node_modules at all', async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-isolated-'))
    try {
      const copy = path.join(isolated, 'agentchat')
      fs.copyFileSync(BIN, copy)
      const { stdout } = await exec(process.execPath, [copy, '--version'], { env: { ...process.env, HOME: isolated, AGENTCHAT_API_KEY: '' } })
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true })
    }
  })

  it('reads no message content anywhere: the bundle carries no body parser', () => {
    const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'daemon-main.js'), 'utf-8')
    expect(bundle).not.toMatch(/messages\/sync/)
    expect(bundle).not.toMatch(/type:\s*['"]ack['"]/)
  })
})
