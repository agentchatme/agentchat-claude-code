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
      env: { PATH: process.env['PATH'] ?? '', HOME: sandbox, AGENTCHAT_SERVICE_DRY_RUN: '1', ...env },
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

describe('the daemon bundle ships with the plugin', () => {
  it('is committed, because a plugin install is a git clone with no build step', () => {
    expect(fs.existsSync(DAEMON)).toBe(true)
  })

  it('is a different artifact from the CLI — the CLI must never carry the socket layer', () => {
    const cli = fs.readFileSync(CLI, 'utf-8')
    const daemon = fs.readFileSync(DAEMON, 'utf-8')
    // `ws` is CommonJS and reaches for `require` at runtime; bundled into the
    // CLI it kills `status`, `register` and both hooks at startup.
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
    // Claude Code's hooks invoke the bundle by absolute path, so this
    // integration is not exposed the way the npx-installed Codex package was —
    // where resolving the daemon relative to process.argv[1] pointed at
    // node_modules/.bin/ and broke `daemon install` for every user in 0.0.12.
    // Pinned here anyway: the resolution should depend on where the bundle IS,
    // never on how it was called.
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

// ─── The committed hooks.json must invoke commands this CLI accepts ─────────
//
// The Codex integration shipped 0.0.13 with every session hook broken: its
// installer wrote `hook <event> --platform codex`, a leftover from the shared
// CLI, and this generation of the binary rejects that flag. Each hook exited on
// "Unknown option" and printed usage — no digest, no pickup, no acks.
//
// This plugin's hooks.json is COMMITTED, so the same drift is possible and
// would ship to every user with no build step in between. Run what it declares.
describe('the committed hooks.json runs', () => {
  it('every declared hook command is accepted by the bundle', { timeout: 30_000 }, async () => {
    const hooksFile = path.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json')
    const declared = JSON.parse(fs.readFileSync(hooksFile, 'utf-8')) as Record<string, any>
    const events = (declared['hooks'] ?? declared) as Record<string, Array<Record<string, any>>>

    const commands: string[] = []
    for (const groups of Object.values(events)) {
      for (const group of groups) {
        for (const h of group['hooks'] ?? []) {
          if (typeof h?.command === 'string') commands.push(h.command)
        }
      }
    }
    expect(commands.length).toBe(3) // SessionStart + UserPromptSubmit + Stop

    for (const command of commands) {
      // `node "${CLAUDE_PLUGIN_ROOT}/bin/agentchat" hook <event>` — resolve the
      // placeholder the way Claude Code does, then run it.
      const resolved = command.replace('${CLAUDE_PLUGIN_ROOT}', path.join(__dirname, '..', 'plugin'))
      const m = resolved.match(/^node "([^"]+)" (.+)$/)
      expect(m, `unexpected hook command shape: ${command}`).not.toBeNull()
      const { out } = await run(m![1] as string, (m![2] as string).split(/\s+/), {
        AGENTCHAT_HOOKS_ENABLED: '0',
      })
      expect(out, `hook rejected its own arguments: ${command}\n${out}`).not.toMatch(/Unknown option/i)
      expect(out, `hook printed usage instead of running: ${command}\n${out}`).not.toMatch(/^Usage:/im)
    }
  })
})
