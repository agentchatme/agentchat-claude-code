import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
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

const PLUGIN_BIN = path.join(__dirname, '..', 'plugin', 'bin')
const DAEMON = path.join(PLUGIN_BIN, 'agentchat-daemon.mjs')
const CLI = path.join(PLUGIN_BIN, 'agentchat')

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
    execFile(
      process.execPath,
      [script, ...args],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: sandbox,
          // HOME sandboxes where a unit FILE lands, but launchctl/systemctl
          // always address the REAL user's domain. Without this, running these
          // tests registers actual services on the developer's machine pointed
          // at a temp dir that is about to be deleted. It did exactly that.
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
  })
}

describe('the daemon bundle ships with the plugin', () => {
  it('is committed, because a plugin install is a git clone with no build step', () => {
    expect(fs.existsSync(DAEMON)).toBe(true)
  })

  it('is a different artifact from the CLI — the CLI must never carry the socket layer', () => {
    const cli = fs.readFileSync(CLI, 'utf-8')
    const daemon = fs.readFileSync(DAEMON, 'utf-8')
    // `ws` is CommonJS and reaches for `require` at runtime; bundled into the
    // CLI it kills `status`, `register` and both hooks at startup.
    expect(daemon).toContain('holding the wire')
    expect(cli).not.toContain('holding the wire')
  })
})

describe('the daemon entry actually runs', () => {
  it('starts, parses --home, and reaches identity resolution', async () => {
    const home = path.join(sandbox, 'empty-home')
    fs.mkdirSync(home, { recursive: true })

    const { code, out } = await run(DAEMON, ['--home', home])

    // Reaching "no identity" proves it got through module load, argument
    // parsing and into runDaemon. The regression printed usage instead.
    expect(out).toMatch(/no AgentChat identity/i)
    expect(out).not.toMatch(/Unknown option|Usage:/i)
    // And specifically NOT the failure mode of bundling `ws` into ESM.
    expect(out).not.toMatch(/Dynamic require/i)
    expect(code).toBe(1)
  })

  it('carries its whole runtime — no bare-clone module resolution', async () => {
    const home = path.join(sandbox, 'empty-home-2')
    fs.mkdirSync(home, { recursive: true })
    const { out } = await run(DAEMON, ['--home', home])
    // There is no node_modules beside an installed plugin.
    expect(out).not.toMatch(/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i)
  })

  it('acts on the home it is GIVEN, not one it picks', async () => {
    // Two homes, neither with credentials. The error must name the one passed.
    const a = path.join(sandbox, 'home-a')
    const b = path.join(sandbox, 'home-b')
    fs.mkdirSync(a, { recursive: true })
    fs.mkdirSync(b, { recursive: true })

    const ra = await run(DAEMON, ['--home', a])
    expect(ra.out).toContain(a)
    expect(ra.out).not.toContain(b)
  })
})

describe('daemon install points the service at the daemon, not the CLI', () => {
  it('refuses to install without an identity rather than wiring a dead unit', async () => {
    const { code, out } = await run(CLI, ['daemon', 'install'])
    expect(out).toMatch(/register first/i)
    expect(code).toBe(1)
  })

  it('copies the daemon to a durable path outside the version-scoped plugin cache', async () => {
    // A unit pointing inside …/plugins/cache/<mp>/<plugin>/<version>/ dies on
    // the next plugin update. Install must copy the bundle somewhere that
    // survives, and the copy must be byte-identical to what shipped.
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
