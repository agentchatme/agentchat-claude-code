import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { installFakeClaude, type FakeClaude } from './helpers/fake-claude.js'

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
  // still read until 2027-02-01 (agent contract v1, section 7). A service
  // installed before the rename carries it in its unit.
  it('AGENTCHAT_DOORBELL=off (the previous name) still holds no socket, and says it is the previous name', async () => {
    const home = path.join(sandbox, 'off-home')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'cc-agent', api_base: 'http://127.0.0.1:9' }))
    const { out, alive } = await runFor(DAEMON, ['--home', home], 1500, { AGENTCHAT_DOORBELL: 'off' })
    expect(alive).toBe(true)
    expect(out).toContain('AGENTCHAT_DOORBELL=off')
    expect(out).toContain('read until 2027-02-01')
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
