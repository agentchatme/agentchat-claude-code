import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ─── The always-on service runs something that can actually serve ───────────
//
// This file exists because of a shipped defect that every green check missed.
//
// `daemon install` wrote a launchd/systemd unit whose command was
// `<cli> start --home <home>`, but no `start` command existed — the CLI printed
// usage and exited 1. Under `KeepAlive` / `Restart=on-failure` that unit
// restart-looped forever while `daemon status` reported "always-on is ON".
// The daemon runtime was not even in the CLI bundle: the adapter was
// unreferenced and tree-shaken away.
//
// CI was green throughout, because the only check on the daemon was that a
// FILE EXISTED. So the rule here is: never assert a path exists — RUN it, and
// assert it got far enough to prove it is the daemon.

const DIST = path.join(__dirname, '..', 'dist')
const DAEMON = path.join(DIST, 'daemon-main.js')
const CLI = path.join(DIST, 'index.js')

let sandbox: string

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-daemon-'))
})
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

/** Run a script to completion, capturing everything. Never throws. */
function run(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // Close stdin. The hook subcommands read a JSON payload from it, so a child
    // left with an open pipe waits forever — which is also exactly what a host
    // does NOT do: it writes the payload and closes.
    const child = execFile(
      process.execPath,
      [script, ...args],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: sandbox,
          USERPROFILE: sandbox,
          // HOME sandboxes where a unit FILE lands, but launchctl/systemctl
          // always address the REAL user's domain. USERPROFILE is the Windows
          // equivalent used by os.homedir(). Without both, running these tests
          // can register actual services on the developer's machine pointed at
          // a temp dir that is about to be deleted. It did exactly that.
          AGENTCHAT_SERVICE_DRY_RUN: '1',
          ...env,
        },
        timeout: 20_000,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
        resolve({
          code: typeof e?.code === 'number' ? e.code : e ? 1 : 0,
          out: `${stdout}${stderr}`,
        })
      },
    )
    child.stdin?.end()
  })
}

/** Start a script, let it run for `ms`, then kill it. Returns what it said and
 *  whether it was STILL ALIVE — which is the point for a resident daemon. */
function runFor(
  script: string,
  args: string[],
  ms: number,
  env: Record<string, string> = {},
): Promise<{ out: string; alive: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: sandbox,
        USERPROFILE: sandbox,
        AGENTCHAT_SERVICE_DRY_RUN: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let exited = false
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', () => (exited = true))
    setTimeout(() => {
      const alive = !exited
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      setTimeout(() => resolve({ out, alive }), 150)
    }, ms)
  })
}

describe('the daemon bundle ships with the NPX package', () => {
  it('is built as a published package artifact', () => {
    expect(fs.existsSync(DAEMON)).toBe(true)
  })

  it('is a different artifact from the CLI — the CLI must never carry the socket layer', () => {
    const cli = fs.readFileSync(CLI, 'utf-8')
    const daemon = fs.readFileSync(DAEMON, 'utf-8')
    // `ws` is CommonJS and reaches for `require` at runtime; bundled into the
    // CLI it kills every command and lifecycle hook at startup.
    expect(daemon).toContain('daemon up as')
    expect(cli).not.toContain('daemon up as')
  })
})

describe('the daemon is RESIDENT — it idles rather than exiting', () => {
  it('stays alive with no identity instead of exiting and being restarted forever', async () => {
    const home = path.join(sandbox, 'empty-home')
    fs.mkdirSync(home, { recursive: true })

    const { out, alive } = await runFor(DAEMON, ['--home', home], 1500)

    // The regression: it threw "no identity", exited 1, and the service
    // manager restarted it on a loop — which is what `logout` used to leave
    // behind on every machine.
    expect(alive, `the daemon exited instead of idling:\n${out}`).toBe(true)
    expect(out).toMatch(/always-on resident/i)
    expect(out).not.toMatch(/Unknown option|Usage:/i)
    expect(out).not.toMatch(/Dynamic require/i)
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
})

describe('daemon install points the service at the daemon, not the CLI', () => {
  it('registers the service with NO identity — install and sign-in are separate', async () => {
    // It used to refuse without credentials, which is what tied the daemon's
    // existence to the login state: installing gave you no always-on, and
    // logging out left a service that could not resolve an identity.
    const { out } = await run(CLI, ['daemon', 'install'])
    expect(out).not.toMatch(/register first/i)
    expect(out).toMatch(/Always-on is ON/i)
  })

  it('finds the daemon when invoked through a shim rather than by its real path', async () => {
    // NPX invokes through a bin shim. The daemon must be resolved from the
    // installed module, never from process.argv[1], or every NPX install points
    // at a nonexistent node_modules/.bin/daemon-main.js.
    const home = path.join(sandbox, '.claude', 'agentchat')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(home, 'credentials'),
      JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'cc-agent' }),
    )

    const binDir = path.join(sandbox, 'elsewhere', 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const shim = path.join(binDir, 'agentchat')
    fs.symlinkSync(CLI, shim)

    const { out } = await run(shim, ['daemon', 'install'])
    expect(out).not.toMatch(/daemon bundle is missing/i)
    expect(fs.existsSync(path.join(home, 'bin', 'agentchat-daemon.mjs'))).toBe(true)
  })

  it('copies the daemon to a durable path outside the disposable NPX cache', async () => {
    // A unit pointing into an NPX cache dies when that cache is cleaned.
    const home = path.join(sandbox, '.claude', 'agentchat')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(home, 'credentials'),
      JSON.stringify({ api_key: 'ac_live_' + 'a'.repeat(40), handle: 'cc-agent' }),
    )

    // Not asserting on launchctl/systemctl succeeding — this box may have
    // neither. What matters is the durable copy the unit would name.
    await run(CLI, ['daemon', 'install'])

    const stable = path.join(home, 'bin', 'agentchat-daemon.mjs')
    expect(fs.existsSync(stable)).toBe(true)
    expect(fs.readFileSync(stable, 'utf-8')).toBe(fs.readFileSync(DAEMON, 'utf-8'))
    expect(stable.includes('plugins/cache')).toBe(false)
  })
})

// ─── Every lifecycle command written by the installer must be accepted ──────
//
// The Codex integration shipped 0.0.13 with every session hook broken: its
// installer wrote `hook <event> --platform codex`, a leftover from the shared
// CLI, and this generation of the binary rejects that flag. Each hook exited on
// "Unknown option" and printed usage — no digest, no pickup, no acks.
//
describe('the lifecycle hook commands run', () => {
  it('accepts every command the direct installer wires', { timeout: 30_000 }, async () => {
    for (const event of ['session-start', 'user-prompt', 'stop', 'session-end']) {
      const { out } = await run(CLI, ['hook', event], {
        AGENTCHAT_HOOKS_ENABLED: '0',
      })
      expect(out, `hook rejected \`${event}\`:\n${out}`).not.toMatch(/Unknown option/i)
      expect(out, `hook printed usage instead of running:\n${out}`).not.toMatch(/^Usage:/im)
    }
  })
})
