import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_RUN_PROFILE, RUN_PROFILES } from '@agentchatme/agent-core'
import { installFakeClaude, type FakeClaude } from './helpers/fake-claude.js'

/** Whether the engine this build runs on has the `own` profile (the pin moves to it at the release step). */
const ENGINE_HAS_OWN = (RUN_PROFILES as readonly string[]).includes('own')

// ─── The service runs something that can actually serve ─────────────────────
//
// A shipped defect once wired the unit to a command that did not exist; it
// restart-looped forever behind a green pipeline because the only check on the
// daemon was that a FILE EXISTED. So: never assert a path exists — RUN it, and
// assert it got far enough to prove it is the listener.

const DIST = path.join(__dirname, '..', 'dist')
const DAEMON = path.join(DIST, 'daemon-main.js')
const CLI = path.join(DIST, 'index.js')

let sandbox: string
let fakeClaude: FakeClaude

// Every daemon a test started, until it has exited. A daemon that has not
// exited is still writing into the sandbox: on SIGTERM it finishes its current
// tick (up to 250 ms), then writes its status file and releases its lock in
// the home. Removing the sandbox under it fails with ENOTEMPTY — so teardown
// waits for each one to be GONE before it removes anything.
const daemons = new Set<Daemon>()

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-daemon-'))
  fakeClaude = installFakeClaude(sandbox)
})
afterEach(async () => {
  await Promise.all([...daemons].map((daemon) => daemon.stop()))
  // The retries are only a backstop; every writer has already exited.
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const baseEnv = (): Record<string, string> => ({
  PATH: `${fakeClaude.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
  HOME: sandbox,
  USERPROFILE: sandbox,
  // HOME sandboxes where a unit FILE lands, but launchctl/systemctl always
  // address the REAL user's domain. Without this, these tests register actual
  // services on the developer's machine pointed at a temp dir. It happened.
  AGENTCHAT_SERVICE_DRY_RUN: '1',
  // This test file's own agent-lock folder (tests/setup/isolated-locks.ts), never the user's.
  AGENTCHAT_LOCK_DIR: process.env['AGENTCHAT_LOCK_DIR'] ?? path.join(sandbox, 'locks'),
})

/** Run a script to completion, capturing everything. Never throws. */
function run(script: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { env: { ...baseEnv(), ...env }, timeout: 20_000 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
      resolve({ code: typeof e?.code === 'number' ? e.code : e ? 1 : 0, out: `${stdout}${stderr}` })
    })
    child.stdin?.end()
  })
}

/** How long a stopped daemon gets to exit on SIGTERM before it is SIGKILLed (under vitest's 10 s hook timeout). */
const STOP_GRACE_MS = 5_000

interface Daemon {
  /** SIGTERM, SIGKILL after `STOP_GRACE_MS`; resolves once the process has exited and its output is closed. */
  stop(): Promise<void>
}

/** Start a script, let it run for `ms`, then stop it and wait until it is gone. Returns what it said and whether it was STILL ALIVE at `ms`. */
async function runFor(script: string, args: string[], ms: number, env: Record<string, string> = {}): Promise<{ out: string; alive: boolean }> {
  const child: ChildProcess = spawn(process.execPath, [script, ...args], { env: { ...baseEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout?.on('data', (d) => (out += d))
  child.stderr?.on('data', (d) => (out += d))
  // 'close' comes after 'exit' and after stdout/stderr have drained: the
  // process is gone and everything it said has been read.
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  let stopping: Promise<void> | undefined
  const daemon: Daemon = {
    stop: () =>
      (stopping ??= (async () => {
        child.kill('SIGTERM') // a no-op on a process that already exited
        const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
        await closed
        clearTimeout(kill)
        daemons.delete(daemon)
      })()),
  }
  daemons.add(daemon)
  await new Promise((resolve) => setTimeout(resolve, ms))
  const alive = child.exitCode === null && child.signalCode === null
  await daemon.stop()
  return { out, alive }
}

describe('the daemon bundle ships with the NPX package', () => {
  it('is built as a published package artifact', () => {
    expect(fs.existsSync(DAEMON)).toBe(true)
  })

  it('is a different artifact from the CLI — the CLI must never carry the socket layer', () => {
    const cli = fs.readFileSync(CLI, 'utf-8')
    const daemon = fs.readFileSync(DAEMON, 'utf-8')
    expect(daemon).toContain('integration resident')
    expect(cli).not.toContain('integration resident')
  })
})

describe('the daemon is RESIDENT — it idles rather than exiting', () => {
  it('stays alive with no identity instead of exiting and being restarted forever', async () => {
    const home = path.join(sandbox, 'empty-home')
    fs.mkdirSync(home, { recursive: true })
    const { out, alive } = await runFor(DAEMON, ['--home', home], 1500)
    expect(alive, `the daemon exited instead of idling:\n${out}`).toBe(true)
    expect(out).toMatch(/integration resident/i)
    expect(out).not.toMatch(/Unknown option|Usage:/i)
    expect(out).not.toMatch(/Dynamic require/i)
    expect(fs.existsSync(path.join(home, 'integration.status.json'))).toBe(true)
  }, 20_000)

  it('carries its whole runtime — no bare-clone module resolution', async () => {
    const home = path.join(sandbox, 'empty-home-2')
    fs.mkdirSync(home, { recursive: true })
    const { out } = await runFor(DAEMON, ['--home', home], 1200)
    expect(out).not.toMatch(/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i)
  }, 20_000)

  it('acts on the home it is GIVEN, not one it picks', async () => {
    const a = path.join(sandbox, 'home-a')
    const b = path.join(sandbox, 'home-b')
    fs.mkdirSync(a, { recursive: true })
    fs.mkdirSync(b, { recursive: true })
    const { out } = await runFor(DAEMON, ['--home', a], 1200)
    expect(out).toContain(a)
    expect(out).not.toContain(b)
  }, 20_000)

  // A compatibility check: AGENTCHAT_DOORBELL is the switch's previous name,
  // still read; agent contract v1 (section 7) schedules its removal for 2027-02-01. A service
  // installed before the rename carries it in its unit.
  it('AGENTCHAT_DOORBELL=off (the previous name) still holds no socket, and says it is the previous name', async () => {
    const home = path.join(sandbox, 'off-home')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'cc-agent', api_base: 'http://127.0.0.1:9' }))
    const { out, alive } = await runFor(DAEMON, ['--home', home], 1500, { AGENTCHAT_DOORBELL: 'off' })
    expect(alive).toBe(true)
    expect(out).toContain('AGENTCHAT_DOORBELL=off')
    expect(out).toContain('schedules its removal for 2027-02-01')
    const status = JSON.parse(fs.readFileSync(path.join(home, 'integration.status.json'), 'utf-8')) as { socket: string }
    expect(status.socket).toBe('off')
  }, 20_000)
})

describe('daemon install points the service at the daemon, not the CLI', () => {
  it('registers the service with NO identity — install and sign-in are separate', async () => {
    const { out } = await run(CLI, ['daemon', 'install'])
    expect(out).not.toMatch(/register first/i)
    expect(out).toMatch(/Integration daemon is ON/i)
  })

  it('finds the daemon when invoked through a shim rather than by its real path', async () => {
    const home = path.join(sandbox, '.claude', 'agentchat')
    fs.mkdirSync(home, { recursive: true })
    const binDir = path.join(sandbox, 'elsewhere', 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const shim = path.join(binDir, 'agentchat')
    fs.symlinkSync(CLI, shim)
    const { out } = await run(shim, ['daemon', 'install'])
    expect(out).not.toMatch(/daemon bundle is missing/i)
    expect(fs.existsSync(path.join(home, 'bin', 'agentchat-daemon.mjs'))).toBe(true)
  })

  it('copies the daemon to a durable path outside the disposable NPX cache', async () => {
    const home = path.join(sandbox, '.claude', 'agentchat')
    await run(CLI, ['daemon', 'install'])
    const stable = path.join(home, 'bin', 'agentchat-daemon.mjs')
    expect(fs.existsSync(stable)).toBe(true)
    expect(fs.readFileSync(stable, 'utf-8')).toBe(fs.readFileSync(DAEMON, 'utf-8'))
    expect(stable.includes('plugins/cache')).toBe(false)
  })

  it('daemon status reports the service and the integration status file', async () => {
    await run(CLI, ['daemon', 'install'])
    const { out } = await run(CLI, ['daemon', 'status'])
    expect(out).toMatch(/daemon: (idle|starting|off|connected|NOT running)/)
    expect(out).toContain('Integration:')
  })

  it('the retired hook subcommands are gone — receiving needs no hooks', async () => {
    const { code, out } = await run(CLI, ['hook', 'session-start'])
    expect(code).toBe(1)
    expect(out).toContain('Unknown command: hook')
  })
})

// ─── One service per config dir; never touch another config's service ───────
//
// Live-fire E5: the label was global, so a relocated CLAUDE_CONFIG_DIR (a
// sandbox) reported the machine's real service as its own, and `uninstall`
// there would have removed it. Everything here runs with
// AGENTCHAT_SERVICE_DRY_RUN=1 and a temp HOME: only definition files move.

const serviceOs = process.platform === 'darwin' || process.platform === 'linux'

function definitionPath(label: string): string {
  return process.platform === 'darwin'
    ? path.join(sandbox, 'Library', 'LaunchAgents', `me.agentchat.${label}.plist`)
    : path.join(sandbox, '.config', 'systemd', 'user', `${label}.service`)
}

function writeForeignDefinition(label: string, home: string): string {
  const file = definitionPath(label)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    process.platform === 'darwin'
      ? `<plist version="1.0"><dict><key>Label</key><string>me.agentchat.${label}</string><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>${home}/bin/agentchat-daemon.mjs</string><string>--home</string><string>${home}</string></array></dict></plist>\n`
      : `[Service]\nExecStart="/usr/bin/node" "${home}/bin/agentchat-daemon.mjs" --home "${home}"\n`,
  )
  return file
}

describe.skipIf(!serviceOs)('the service label follows the config dir', () => {
  it('~/.claude keeps agentchatd-claude-code; a relocated CLAUDE_CONFIG_DIR gets its own hashed label', async () => {
    expect((await run(CLI, ['daemon', 'install'])).out).toContain('(agentchatd-claude-code)')
    expect(fs.existsSync(definitionPath('agentchatd-claude-code'))).toBe(true)

    const cfg = path.join(sandbox, 'relocated-claude')
    const label = `agentchatd-claude-code-${crypto.createHash('sha256').update(path.resolve(cfg, 'agentchat')).digest('hex').slice(0, 8)}`
    const installed = await run(CLI, ['daemon', 'install'], { CLAUDE_CONFIG_DIR: cfg })
    expect(installed.out).toContain(`(${label})`)
    expect(fs.existsSync(definitionPath(label))).toBe(true)
    const status = await run(CLI, ['daemon', 'status'], { CLAUDE_CONFIG_DIR: cfg })
    expect(status.out).toContain(label)
    // Dry run: the service manager is not consulted, so the machine's real
    // service can never be reported as this config's.
    expect(status.out).toContain('not queried (AGENTCHAT_SERVICE_DRY_RUN)')
    expect(status.out).not.toMatch(/: loaded/)
  })

  it('uninstall refuses a definition under this label that serves another config, and leaves it in place', async () => {
    const foreign = writeForeignDefinition('agentchatd-claude-code', '/Users/someone-else/.claude/agentchat')
    const { code, out } = await run(CLI, ['daemon', 'uninstall'])
    expect(code).toBe(1)
    expect(out).toMatch(/refusing to remove .* serves \/Users\/someone-else\/\.claude\/agentchat/)
    expect(out).not.toMatch(/Integration daemon is OFF/)
    expect(fs.existsSync(foreign)).toBe(true)
  })

  it('installing a relocated config retires its own pre-upgrade plain-label service, never another config’s', async () => {
    const cfg = path.join(sandbox, 'relocated-claude')
    const home = path.resolve(cfg, 'agentchat')
    const legacy = writeForeignDefinition('agentchatd-claude-code', home) // installed before labels were per config
    await run(CLI, ['daemon', 'install'], { CLAUDE_CONFIG_DIR: cfg })
    expect(fs.existsSync(legacy)).toBe(false)

    const other = writeForeignDefinition('agentchatd-claude-code', path.join(sandbox, '.claude', 'agentchat'))
    await run(CLI, ['daemon', 'install'], { CLAUDE_CONFIG_DIR: cfg })
    expect(fs.existsSync(other)).toBe(true)
  })
})

describe.skipIf(!serviceOs)('daemon install captures the switches into the service', () => {
  // A launchd/systemd service does not inherit the shell, so the switches are
  // written into its definition. AGENTCHAT_DOORBELL is captured too: it is the
  // off switch's previous name, a compatibility reader the daemon still reads
  // until 2027-02-01, and an operator who sets it must find it in the unit.
  it('the off switch under both names, and the run profile, land in the definition', async () => {
    const installed = await run(CLI, ['daemon', 'install'], { AGENTCHAT_INTEGRATION: 'off', AGENTCHAT_DOORBELL: 'off', AGENTCHAT_RUN_PROFILE: 'work' })
    expect(installed.code, installed.out).toBe(0)
    const definition = fs.readFileSync(definitionPath('agentchatd-claude-code'), 'utf-8')
    for (const [key, value] of [['AGENTCHAT_INTEGRATION', 'off'], ['AGENTCHAT_DOORBELL', 'off'], ['AGENTCHAT_RUN_PROFILE', 'work']] as const) {
      // systemd: Environment="KEY=value"; launchd: <key>KEY</key><string>value</string>
      expect(definition).toMatch(new RegExp(`${key}(=|</key>\\s*<string>)${value}`))
    }
  })

  // The upgrade path: a profile is captured only when it was set, so an install
  // that set none runs whatever the engine's default is when its daemon starts
  // (`own` from the engine that added it; `answer` before).
  it('an install that sets no profile captures none: its daemon runs the engine’s default', async () => {
    const installed = await run(CLI, ['daemon', 'install'])
    expect(installed.code, installed.out).toBe(0)
    expect(fs.readFileSync(definitionPath('agentchatd-claude-code'), 'utf-8')).not.toContain('AGENTCHAT_RUN_PROFILE')
    expect(installed.out).toContain(`with profile ${DEFAULT_RUN_PROFILE} while this machine is up — `)
  })

  // Pinned on purpose, so that changing it is a decision and not an accident:
  // every install, `daemon install` and `doctor --fix` writes the definition
  // again from the shell that runs it. A switch captured earlier is not
  // carried forward — an `off` set at `daemon install` is gone after a plain
  // install from a shell without it. `daemon disable` is the off that
  // survives every install and `doctor --fix`.
  it('a later install from a shell without the switch writes the definition without it; daemon disable is the off that survives', async () => {
    const label = definitionPath('agentchatd-claude-code')
    expect((await run(CLI, ['daemon', 'install'], { AGENTCHAT_INTEGRATION: 'off' })).code).toBe(0)
    expect(fs.readFileSync(label, 'utf-8')).toMatch(/AGENTCHAT_INTEGRATION(=|<\/key>\s*<string>)off/)

    const plain = await run(CLI, [])
    expect(plain.code, plain.out).toBe(0)
    expect(fs.readFileSync(label, 'utf-8')).not.toContain('AGENTCHAT_INTEGRATION')

    expect((await run(CLI, ['daemon', 'disable'])).code).toBe(0)
    expect(fs.existsSync(label)).toBe(false)
    expect((await run(CLI, [])).code).toBe(0)
    expect((await run(CLI, ['doctor', '--fix'])).out).toContain('disabled by the user')
    expect(fs.existsSync(label)).toBe(false)
  })
})

// ─── Switched off on purpose: AgentChat is told, before the service goes ─────
//
// The listener report (contract v1 §3.13): `uninstall` and `daemon disable`
// say `stopped` under this home's listener id while the key and the service
// are still there, so the agent reads as switched off, not as a computer that
// is off. A loopback server stands in for AgentChat and notes, as each report
// arrives, whether the service definition still exists.

interface StopReport {
  readonly body: unknown
  readonly definitionThere: boolean
}

async function listenerServer(definition: string): Promise<{ url: string; reports: StopReport[]; close: () => Promise<void> }> {
  const http = await import('node:http')
  const reports: StopReport[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf-8')))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.method !== 'PUT' || req.url !== '/v1/agents/me/listener') {
        res.statusCode = 404
        res.end('{}')
        return
      }
      reports.push({ body: JSON.parse(raw) as unknown, definitionThere: fs.existsSync(definition) })
      const at = new Date().toISOString()
      res.end(JSON.stringify({ listener: { ...(JSON.parse(raw) as object), reason_kind: null, state_since: at, reported_at: at } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return { url: `http://127.0.0.1:${address.port}`, reports, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

describe.skipIf(!serviceOs)('switched off on purpose: stopped is reported before the service goes', () => {
  const LISTENER_ID = 'cc_listener_0000000000'
  const signedIn = (apiBase: string, withListener: boolean): void => {
    const home = path.join(sandbox, '.claude', 'agentchat')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'cc-agent', api_base: apiBase }))
    if (withListener) fs.writeFileSync(path.join(home, 'listener-id'), `${LISTENER_ID}\n`)
  }

  it.each([[['uninstall']], [['daemon', 'disable']], [['daemon', 'uninstall']]])('%j: one stopped report under the home\'s listener id while the service is still there, then the service goes', async (args) => {
    const definition = definitionPath('agentchatd-claude-code')
    const server = await listenerServer(definition)
    try {
      expect((await run(CLI, ['daemon', 'install'])).code).toBe(0)
      expect(fs.existsSync(definition)).toBe(true)
      signedIn(server.url, true)
      const { out } = await run(CLI, args)
      expect(server.reports).toEqual([{ body: { instance_id: LISTENER_ID, state: 'stopped' }, definitionThere: true }])
      expect(fs.existsSync(definition)).toBe(false)
      expect(out).toContain('✓ listener: AgentChat was told it stopped on purpose')
    } finally {
      await server.close()
    }
  })

  it('no listener of this home ever reported (no id): nothing is sent, nothing is said; AgentChat not answering never fails the command', async () => {
    const definition = definitionPath('agentchatd-claude-code')
    const server = await listenerServer(definition)
    try {
      await run(CLI, ['daemon', 'install'])
      signedIn(server.url, false)
      const quiet = await run(CLI, ['daemon', 'disable'])
      expect(quiet.code).toBe(0)
      expect(server.reports).toHaveLength(0)
      expect(quiet.out).not.toContain('listener:')
    } finally {
      await server.close()
    }
    // Nothing listens there now: the command says so and still succeeds.
    await run(CLI, ['daemon', 'install'])
    signedIn(server.url, true)
    const unanswered = await run(CLI, ['daemon', 'disable'])
    expect(unanswered.code).toBe(0)
    expect(unanswered.out).toMatch(/– listener: could not tell AgentChat it stopped \(.+\); AgentChat shows it as offline instead/)
    expect(fs.existsSync(definitionPath('agentchatd-claude-code'))).toBe(false)
  })

  it('an exported key the home does not hold is not this listener\'s agent: nothing is sent for it', async () => {
    const definition = definitionPath('agentchatd-claude-code')
    const server = await listenerServer(definition)
    try {
      await run(CLI, ['daemon', 'install'])
      const home = path.join(sandbox, '.claude', 'agentchat')
      fs.mkdirSync(home, { recursive: true })
      fs.writeFileSync(path.join(home, 'listener-id'), 'cc_listener_0000000000\n')
      const off = await run(CLI, ['daemon', 'disable'], { AGENTCHAT_API_KEY: 'ac_live_' + 'e'.repeat(40), AGENTCHAT_API_BASE: server.url })
      expect(off.code).toBe(0)
      expect(server.reports).toHaveLength(0)
      expect(off.out).not.toContain('listener:')
      expect(fs.existsSync(definition)).toBe(false)
    } finally {
      await server.close()
    }
  })
})

// ─── Runs work BESIDE the identity home, never inside it ────────────────────
//
// Every run's file tools are denied the identity home. The default workdir
// used to be `<home>/daemon-workdir` — a cwd the run could not read. The unit
// passes only `--home`, so the SHIPPED daemon's default is what decides this;
// it is driven here with an identity and a fake claude so preflight runs.

describe('the run workdir is outside the identity home', () => {
  const signIn = (home: string): void => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'cc-agent', api_base: 'http://127.0.0.1:9' }))
  }

  it('the shipped daemon creates its default workdir beside the identity home and nothing inside it', async () => {
    // HOME is the sandbox: the identity home is <sandbox>/.claude/agentchat, what the unit passes as --home.
    const home = path.join(sandbox, '.claude', 'agentchat')
    signIn(home)
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000)
    expect(alive, out).toBe(true)
    expect(out).toMatch(/integration resident/)
    expect(fs.existsSync(path.join(sandbox, '.claude', 'agentchat-workdir')), out).toBe(true)
    expect(fs.existsSync(path.join(home, 'daemon-workdir'))).toBe(false)
    expect(out).not.toMatch(/cannot read their own working directory/)
  }, 30_000)

  it.skipIf(!ENGINE_HAS_OWN)('with no profile set, the shipped daemon serves own; its status names the profile and the runtime', async () => {
    const home = path.join(sandbox, '.claude', 'agentchat')
    signIn(home)
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000)
    expect(alive, out).toBe(true)
    expect(out).toMatch(/integration up as @cc-agent via claude \(claude-code [^)]+\), profile own/)
    expect(out).not.toMatch(/AgentChat-only tool config|not connecting yet/)
    const status = JSON.parse(fs.readFileSync(path.join(home, 'integration.status.json'), 'utf-8')) as { profile: string; runtime_label?: string }
    expect(status.profile).toBe('own')
    expect(status.runtime_label).toBe('Claude Code')
  }, 30_000)

  it('the shipped daemon’s answer runner passes its preflight: it is given the AgentChat-only tool config an answer run needs', async () => {
    // Without that config the engine refuses every answer run ("an answer run
    // needs the AgentChat-only tool config") and the daemon never holds the socket.
    const home = path.join(sandbox, '.claude', 'agentchat')
    signIn(home)
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000, { AGENTCHAT_RUN_PROFILE: 'answer' })
    expect(alive, out).toBe(true)
    expect(out).toMatch(/integration up as @cc-agent via claude \(claude-code [^)]+\), profile answer/)
    expect(out).not.toMatch(/AgentChat-only tool config|not connecting yet/)
    // No run happened, so no per-run file exists; the folder they go in is the denied identity home.
    expect(fs.existsSync(path.join(home, 'presets'))).toBe(false)
  }, 30_000)

  it('what an interrupted answer run left in the identity home is removed when the daemon starts serving the identity, and nothing else there', async () => {
    const home = path.join(sandbox, '.claude', 'agentchat')
    signIn(home)
    const presets = path.join(home, 'presets')
    fs.mkdirSync(presets, { recursive: true })
    fs.writeFileSync(path.join(presets, 'claude-code.mcp.cut-off.json'), '{"mcpServers":{}}', { mode: 0o600 })
    fs.writeFileSync(path.join(presets, 'claude-code.mcp.cut-off.identity.md'), 'line\n')
    fs.writeFileSync(path.join(presets, 'keep.txt'), 'mine')
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000)
    expect(alive, out).toBe(true)
    expect(out).toContain(`removed 2 file(s) an interrupted run left in ${home}`)
    expect(fs.readdirSync(presets)).toEqual(['keep.txt'])
  }, 30_000)

  it('AGENTCHAT_RUN_CWD inside the identity home is warned once, with the fix, and the daemon still serves', async () => {
    const home = path.join(sandbox, '.claude', 'agentchat')
    signIn(home)
    const inside = path.join(home, 'daemon-workdir')
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000, { AGENTCHAT_RUN_CWD: inside })
    expect(alive, out).toBe(true)
    const warnings = out.split('\n').filter((line) => line.includes('cannot read their own working directory'))
    expect(warnings, out).toHaveLength(1)
    expect(warnings[0]).toContain(inside)
    expect(warnings[0]).toContain(path.join(sandbox, '.claude', 'agentchat-workdir'))
    expect(warnings[0]).toContain('daemon install')
  }, 30_000)
})

// ─── The identity line in CLAUDE.md follows the served texts ────────────────
describe('the identity line in CLAUDE.md follows the served texts', () => {
  const signIn = (home: string): void => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'cc-agent', api_base: 'http://127.0.0.1:9' }))
  }

  // The daemon is handed Claude Code's always-loaded instruction file and
  // brings this agent's block there to the served line whenever its texts
  // change, starting with the copy kept in the identity home: no server is
  // reachable here (api_base 127.0.0.1:9), so the kept copy is what it has.
  const servedTexts = (line: string) => ({
    version: '7',
    manual: { url: 'https://manual.example.test/skill.md', version: '9.9.9' },
    wake_instruction: 'SERVED WAKE INSTRUCTION: call mcp__agentchat__agentchat_inbox first.',
    invite_prompt: 'SERVED INVITE PROMPT.',
    identity_line: line,
    identity_line_template: line.replace('@cc-agent', '@<handle>'),
  })
  const keepTexts = (home: string, line: string): void => {
    fs.writeFileSync(path.join(home, 'texts.json'), JSON.stringify({ version: 1, runtime: 'claude-code', fetched_at: new Date().toISOString(), texts: servedTexts(line) }))
  }
  const block = (handle: string, line: string): string => [`<!-- agentchat:start -->`, `<!-- agentchat:handle ${handle} -->`, line, `<!-- agentchat:end -->`].join('\n')
  const OLD_LINE = 'I am @cc-agent on AgentChat (api.agentchat.me). The line install placed.'
  const NEW_LINE = 'I am @cc-agent on AgentChat (api.agentchat.me). The line served now.'
  const USER = '# My Claude Code instructions\n\nPrefer small commits.'

  it('the shipped daemon brings this agent\'s CLAUDE.md block to the served identity line, keeping the user\'s text, and says so', async () => {
    const home = path.join(sandbox, '.claude', 'agentchat')
    signIn(home)
    keepTexts(home, NEW_LINE)
    const claudeMd = path.join(sandbox, '.claude', 'CLAUDE.md')
    fs.writeFileSync(claudeMd, `${USER}\n\n${block('cc-agent', OLD_LINE)}\n`)
    const { out, alive } = await runFor(DAEMON, ['--home', home], 6000)
    expect(alive, out).toBe(true)
    expect(fs.readFileSync(claudeMd, 'utf-8'), out).toBe(`${USER}\n\n${block('cc-agent', NEW_LINE)}\n`)
    expect(out).toMatch(/identity line: updated — the identity line for @cc-agent in .*CLAUDE\.md now is the served one/)
    const status = JSON.parse(fs.readFileSync(path.join(home, 'integration.status.json'), 'utf-8')) as { identity_line?: { outcome: string; path: string; texts_version: string } }
    expect(status.identity_line).toMatchObject({ outcome: 'updated', path: claudeMd, texts_version: '7' })
  }, 30_000)

  it('it follows CLAUDE_CONFIG_DIR, and leaves another agent\'s block, and a CLAUDE.md with no block, as they are', async () => {
    const configDir = path.join(sandbox, 'relocated-claude')
    const home = path.join(configDir, 'agentchat')
    signIn(home)
    keepTexts(home, NEW_LINE)
    // The default config's file is not this daemon's: it is never written.
    const defaultMd = path.join(sandbox, '.claude', 'CLAUDE.md')
    fs.mkdirSync(path.dirname(defaultMd), { recursive: true })
    fs.writeFileSync(defaultMd, `${USER}\n\n${block('cc-agent', OLD_LINE)}\n`)
    const relocatedMd = path.join(configDir, 'CLAUDE.md')
    const otherAgent = `${USER}\n\n${block('someone-else', 'I am @someone-else on AgentChat.')}\n`
    fs.writeFileSync(relocatedMd, otherAgent)
    let run = await runFor(DAEMON, ['--home', home], 6000, { CLAUDE_CONFIG_DIR: configDir })
    expect(run.alive, run.out).toBe(true)
    expect(fs.readFileSync(relocatedMd, 'utf-8')).toBe(otherAgent)
    expect(fs.readFileSync(defaultMd, 'utf-8')).toBe(`${USER}\n\n${block('cc-agent', OLD_LINE)}\n`)
    expect(run.out).toMatch(/identity line: other_agent — the AgentChat block in .*relocated-claude.*CLAUDE\.md is @someone-else's, not @cc-agent's; left as it is \(`doctor` reports the mismatch\)/)

    fs.writeFileSync(relocatedMd, `${USER}\n`)
    run = await runFor(DAEMON, ['--home', home], 6000, { CLAUDE_CONFIG_DIR: configDir })
    expect(run.alive, run.out).toBe(true)
    expect(fs.readFileSync(relocatedMd, 'utf-8')).toBe(`${USER}\n`)
    expect(run.out).toMatch(/identity line: absent — no AgentChat block in .*relocated-claude/)
  }, 40_000)
})
