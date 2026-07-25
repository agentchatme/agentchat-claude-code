import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const exec = promisify(execFile)
// Drives the COMMITTED plugin bundle — the exact file Claude Code's hooks run.
const BIN = path.join(__dirname, '..', 'plugin', 'bin', 'agentchat')

// ─── This binary can only act on Claude Code ────────────────────────────────
//
// The property is structural, not defensive. The host is a compile-time fact
// of this package: no `--platform` option exists, no host detection, and no
// branch that could resolve another agent's home.
//
// Its predecessor was one CLI serving every coding agent, whose commands had
// to choose a host. They chose wrong: registering one agent rewrote another's
// instruction file, and logout deleted both agents' credentials. Those bugs
// are not fixed here — they are unwritable.

let sandbox: string

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-integration-'))
  fs.mkdirSync(path.join(sandbox, '.claude'), { recursive: true })
  // A fully set-up Codex agent sharing the machine.
  fs.mkdirSync(path.join(sandbox, '.codex', 'agentchat'), { recursive: true })
  fs.writeFileSync(
    path.join(sandbox, '.codex', 'agentchat', 'credentials'),
    JSON.stringify({ api_key: 'ac_live_' + 'c'.repeat(40), handle: 'codex-agent' }),
  )
  fs.writeFileSync(
    path.join(sandbox, '.codex', 'AGENTS.md'),
    '<!-- agentchat:start -->\nYou are **@codex-agent** on AgentChat.\n<!-- agentchat:end -->\n',
  )
  fs.writeFileSync(
    path.join(sandbox, '.codex', 'config.toml'),
    '[model]\nname = "o4"\n\n# agentchat:start\n[mcp_servers.agentchat]\n# agentchat:end\n',
  )
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

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        HOME: sandbox,
        USERPROFILE: sandbox,
        CODEX_HOME: path.join(sandbox, '.codex'),
        AGENTCHAT_API_KEY: '',
        AGENTCHAT_API_BASE: 'http://127.0.0.1:9',
        AGENTCHAT_LOG_LEVEL: 'silent',
      },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

const codexDir = (): string => path.join(sandbox, '.codex')
const claudeCreds = (): string => path.join(sandbox, '.claude', 'agentchat', 'credentials')

function giveClaudeAnIdentity(): void {
  fs.mkdirSync(path.join(sandbox, '.claude', 'agentchat'), { recursive: true })
  fs.writeFileSync(claudeCreds(), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'claude-agent' }))
  fs.writeFileSync(
    path.join(sandbox, '.claude', 'CLAUDE.md'),
    '# My notes\n\n<!-- agentchat:start -->\nYou are **@claude-agent** on AgentChat.\n<!-- agentchat:end -->\n',
  )
}

describe('there is no way to address another agent', () => {
  it('--platform is not a recognised option at all', async () => {
    const out = await run(['status', '--platform', 'codex'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain("Unknown option '--platform'")
  })

  it('logout removes only this agent’s footprint', async () => {
    giveClaudeAnIdentity()
    const before = snapshot(codexDir())

    const out = await run(['logout'])

    expect(out.code).toBe(0)
    // The Codex agent's credentials, anchor and wiring all survive.
    expect(snapshot(codexDir())).toEqual(before)
    expect(fs.readFileSync(path.join(codexDir(), 'config.toml'), 'utf-8')).toContain('[mcp_servers.agentchat]')
    expect(fs.readFileSync(path.join(codexDir(), 'AGENTS.md'), 'utf-8')).toContain('@codex-agent')
    // …while this agent really is signed out.
    expect(fs.existsSync(claudeCreds())).toBe(false)
    expect(fs.readFileSync(path.join(sandbox, '.claude', 'CLAUDE.md'), 'utf-8')).not.toContain('@claude-agent')
  })

  it('points at the OTHER agent’s front door rather than offering to do it', async () => {
    const out = await run(['--help'])
    expect(out.stdout).toContain('npx -y @agentchatme/codex')
    expect(out.stdout.toLowerCase()).toContain('separate agentchat agent')
  })

  it('keeps the user’s own CLAUDE.md content when signing out', async () => {
    giveClaudeAnIdentity()
    await run(['logout'])
    expect(fs.readFileSync(path.join(sandbox, '.claude', 'CLAUDE.md'), 'utf-8')).toBe('# My notes\n')
  })
})

describe('doctor', () => {
  it('reports the missing identity before registration', async () => {
    const out = await run(['doctor'])
    expect(out.stdout).toContain('FAIL credentials')
  })

  it('detects an anchor naming a different agent, and --fix repairs it', async () => {
    giveClaudeAnIdentity()
    // Exactly the corruption the old shared CLI produced on a two-agent box.
    fs.writeFileSync(
      path.join(sandbox, '.claude', 'CLAUDE.md'),
      '<!-- agentchat:start -->\nYou are **@codex-agent** on AgentChat.\n<!-- agentchat:end -->\n',
    )
    const before = snapshot(codexDir())

    const seen = await run(['doctor'])
    expect(seen.stdout).toContain('says @codex-agent but this agent is @claude-agent')

    const fixed = await run(['doctor', '--fix'])
    expect(fixed.stdout).toContain('repaired → @claude-agent')
    const md = fs.readFileSync(path.join(sandbox, '.claude', 'CLAUDE.md'), 'utf-8')
    expect(md).toContain('@claude-agent')
    expect(md).not.toContain('@codex-agent')
    // Repairing this agent must not touch the one it was confused with.
    expect(snapshot(codexDir())).toEqual(before)
  })
})

describe('status', () => {
  it('is the default command — the plugin is installed by Claude Code, not by us', async () => {
    const out = await run([])
    expect(out.stdout).toContain('No AgentChat identity for this Claude Code agent')
  })
})

describe('every hint is a runnable command', () => {
  for (const argv of [[], ['--help'], ['status'], ['doctor'], ['logout']]) {
    it(`\`${argv.join(' ') || '(bare)'}\` renders no un-interpolated placeholder`, async () => {
      const out = await run(argv)
      expect(out.stdout + out.stderr).not.toContain('${')
    })
  }
})
