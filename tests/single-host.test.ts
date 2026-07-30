import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { installFakeClaude, type FakeClaude } from './helpers/fake-claude.js'

const exec = promisify(execFile)
// Drives the publishable NPX bundle — the exact file the stable copy derives
// from and Claude Code's direct hooks run.
const BIN = path.join(__dirname, '..', 'dist', 'index.js')

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
let fakeClaude: FakeClaude

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-integration-'))
  fs.mkdirSync(path.join(sandbox, '.claude'), { recursive: true })
  fakeClaude = installFakeClaude(sandbox)
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

async function run(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
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

  it('uninstall stops the durable integration but preserves this agent identity', async () => {
    const installed = await run([])
    expect(installed.code, installed.stderr).toBe(0)
    giveClaudeAnIdentity()
    const before = snapshot(codexDir())

    const out = await run(['uninstall'])

    expect(out.code).toBe(0)
    expect(out.stdout).toContain('identity was preserved')
    expect(fs.existsSync(claudeCreds())).toBe(true)
    expect(fs.existsSync(path.join(sandbox, '.claude', 'agentchat', 'always-on.optout'))).toBe(true)
    expect(fs.existsSync(path.join(sandbox, '.claude', 'agentchat', 'bin', 'agentchat-daemon.mjs'))).toBe(false)
    expect(fs.existsSync(path.join(sandbox, '.claude', 'agentchat', 'bin', 'agentchat.mjs'))).toBe(false)
    const userState = JSON.parse(fs.readFileSync(fakeClaude.mcpState, 'utf-8')) as {
      mcpServers?: Record<string, unknown>
    }
    expect(userState.mcpServers?.['agentchat']).toBeUndefined()
    expect(fs.existsSync(path.join(sandbox, '.claude', 'settings.json'))).toBe(false)
    expect(fs.readFileSync(path.join(sandbox, '.claude', 'CLAUDE.md'), 'utf-8')).not.toContain(
      '@claude-agent',
    )
    expect(snapshot(codexDir())).toEqual(before)
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
  it('a bare command installs the direct integration', async () => {
    const out = await run([])
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toContain('Claude Code: wired ✓')
    expect(out.stdout).toContain('Last step')
  })

  it('honours CLAUDE_CONFIG_DIR for identity and always-on state', async () => {
    const relocated = path.join(sandbox, 'relocated-claude')
    const out = await run(['daemon', 'install'], { CLAUDE_CONFIG_DIR: relocated })

    expect(out.code).toBe(0)
    expect(
      fs.existsSync(path.join(relocated, 'agentchat', 'bin', 'agentchat-daemon.mjs')),
    ).toBe(true)
    expect(fs.existsSync(path.join(sandbox, '.claude', 'agentchat', 'always-on.wanted'))).toBe(
      false,
    )
  })

  it('does not undo an explicit always-on disable during an upgrade', async () => {
    expect((await run([])).code).toBe(0)
    expect((await run(['daemon', 'disable'])).code).toBe(0)

    const upgraded = await run([])

    expect(upgraded.code).toBe(0)
    expect(upgraded.stdout).toContain('always-on remains off (user choice)')
    expect(
      fs.existsSync(path.join(sandbox, '.claude', 'agentchat', 'always-on.optout')),
    ).toBe(true)
  })
})

describe('direct Claude Code wiring', () => {
  it('refuses a Claude build that predates shell-free hook arguments', async () => {
    fakeClaude = installFakeClaude(sandbox, '2.1.138')

    const out = await run([])

    expect(out.code).toBe(1)
    expect(out.stdout).toContain('requires Claude Code >= 2.1.139')
    expect(fs.existsSync(path.join(sandbox, '.claude', 'settings.json'))).toBe(false)
    expect(
      fs.existsSync(path.join(sandbox, '.claude', 'agentchat', 'bin', 'agentchat.mjs')),
    ).toBe(false)
  })

  it('owns user-scoped MCP and four hooks through the stable bundle', async () => {
    fs.writeFileSync(
      path.join(sandbox, '.claude', 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }],
            },
          ],
        },
      }),
    )

    const first = await run([])
    expect(first.code, first.stderr).toBe(0)

    const stable = path.join(sandbox, '.claude', 'agentchat', 'bin', 'agentchat.mjs')
    const settings = JSON.parse(
      fs.readFileSync(path.join(sandbox, '.claude', 'settings.json'), 'utf-8'),
    ) as {
      theme: string
      hooks: Record<
        string,
        Array<{
          matcher?: string
          hooks: Array<{ type?: string; command: string; args?: string[] }>
        }>
      >
    }
    expect(settings.theme).toBe('dark')
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    )
    expect(settings.hooks.Stop?.some((group) =>
      group.hooks.some((hook) => hook.command === '/usr/local/bin/user-hook'),
    )).toBe(true)
    for (const event of Object.values(settings.hooks)) {
      expect(event.some((group) =>
        group.hooks.some((hook) =>
          hook.command === 'node' &&
          hook.args?.[0] === stable &&
          hook.args?.[1] === 'hook',
        ),
      )).toBe(true)
    }
    expect(settings.hooks.SessionStart?.find((group) =>
      group.hooks.some((hook) => hook.args?.[1] === 'hook'),
    )?.matcher).toBe('startup|resume|clear|fork')

    const mcpDoc = JSON.parse(fs.readFileSync(fakeClaude.mcpState, 'utf-8')) as {
      mcpServers: {
        agentchat: { type: string; command: string; args: string[]; env: Record<string, string> }
      }
    }
    expect(mcpDoc.mcpServers.agentchat).toEqual({
      type: 'stdio',
      command: 'node',
      args: [stable, 'mcp-proxy'],
      env: {},
    })

    // Users can add a command beside ours in the same matcher group. Upgrade
    // and uninstall must remove only our leaf, never their neighbor.
    const ownedStopGroup = settings.hooks.Stop?.find((group) =>
      group.hooks.some((hook) => hook.args?.[0] === stable),
    )
    expect(ownedStopGroup).toBeDefined()
    ownedStopGroup?.hooks.push({
      type: 'command',
      command: '/usr/local/bin/co-located-user-hook',
    })
    fs.writeFileSync(
      path.join(sandbox, '.claude', 'settings.json'),
      JSON.stringify(settings, null, 2) + '\n',
    )

    const second = await run([])
    expect(second.code, second.stderr).toBe(0)
    const rerun = fs.readFileSync(path.join(sandbox, '.claude', 'settings.json'), 'utf-8')
    expect((rerun.match(/agentchat\.mjs/g) ?? []).length).toBe(4)

    const removed = await run(['uninstall'])
    expect(removed.code, removed.stderr).toBe(0)
    const preserved = JSON.parse(
      fs.readFileSync(path.join(sandbox, '.claude', 'settings.json'), 'utf-8'),
    ) as {
      theme: string
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(preserved).toEqual({
      theme: 'dark',
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }],
          },
          {
            hooks: [
              {
                type: 'command',
                command: '/usr/local/bin/co-located-user-hook',
              },
            ],
          },
        ],
      },
    })
  })

  it('replaces the legacy user plugin only after direct wiring succeeds', async () => {
    fs.writeFileSync(fakeClaude.pluginState, 'installed')
    const out = await run([])
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toContain('legacy marketplace plugin removed')
    expect(fs.existsSync(fakeClaude.pluginState)).toBe(false)
  })

  it('refuses to overwrite a foreign MCP server with the same name', async () => {
    fs.writeFileSync(
      fakeClaude.mcpState,
      JSON.stringify({
        mcpServers: {
          agentchat: { type: 'stdio', command: 'foreign-agentchat', args: [], env: {} },
        },
      }),
    )
    fs.writeFileSync(fakeClaude.pluginState, 'installed')

    const out = await run([])

    expect(out.code).toBe(1)
    expect(out.stdout).toContain('left it untouched')
    expect(JSON.parse(fs.readFileSync(fakeClaude.mcpState, 'utf-8'))).toMatchObject({
      mcpServers: { agentchat: { command: 'foreign-agentchat' } },
    })
    expect(fs.existsSync(fakeClaude.pluginState)).toBe(true)
    expect(fs.existsSync(path.join(sandbox, '.claude', 'settings.json'))).toBe(false)
    expect(
      fs.existsSync(path.join(sandbox, '.claude', 'agentchat', 'bin', 'agentchat.mjs')),
    ).toBe(false)
  })

  it('diagnoses a per-project MCP disable and keeps the legacy path during migration', async () => {
    const project = path.join(sandbox, 'project-with-disabled-mcp')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(
      fakeClaude.mcpState,
      JSON.stringify({
        projects: {
          [project]: {
            disabledMcpServers: ['agentchat'],
          },
        },
      }),
    )
    fs.writeFileSync(fakeClaude.pluginState, 'installed')

    const out = await run([], { CLAUDE_PROJECT_DIR: project })

    expect(out.code).toBe(1)
    expect(out.stdout).toContain('AgentChat MCP is disabled')
    expect(out.stdout).toContain('legacy plugin was left in place')
    expect(fs.existsSync(fakeClaude.pluginState)).toBe(true)
    expect(
      fs.existsSync(path.join(sandbox, '.claude', 'agentchat', 'bin', 'agentchat.mjs')),
    ).toBe(true)

    const doctor = await run(['doctor'], { CLAUDE_PROJECT_DIR: project })
    expect(doctor.stdout).toContain('FAIL project-mcp')
    expect(doctor.stdout).toContain('AgentChat MCP is disabled')
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

describe('the publishable bundle runs after its NPX cache is gone', () => {
  it('has no external imports left to resolve', async () => {
    // The installer copies this file into a durable home. A single external
    // import would become a hard crash as soon as the NPX cache is cleaned.
    const bundle = fs.readFileSync(BIN, 'utf-8')
    expect(bundle).not.toMatch(/^import .* from ["'](agentchatme|@agentchatme\/|zod)/m)
  })

  it('executes when copied somewhere with no node_modules at all', async () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-isolated-'))
    try {
      const copy = path.join(isolated, 'agentchat')
      fs.copyFileSync(BIN, copy)
      const { stdout } = await exec(process.execPath, [copy, '--version'], {
        env: { ...process.env, HOME: isolated, AGENTCHAT_API_KEY: '' },
      })
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true })
    }
  })
})
