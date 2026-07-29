import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ─── Installing mid-session must not silently skip always-on ────────────────
//
// Claude Code runs no code when a plugin is installed — an install is a git
// clone — so a hook is the only place always-on can be registered. It used to
// be registered ONLY from SessionStart.
//
// But installing a plugin mid-session is the normal case. Claude Code picks up
// the new hooks for later events in that session and never re-fires
// SessionStart, so the one hook that registers always-on never ran. On the
// first real install this produced an agent that was registered, signed in,
// and had no daemon at all: `launchctl list | grep agentchat` was empty and
// ~/.claude/agentchat/ had no always-on.wanted. It self-healed only if the
// user happened to open a fresh session.
//
// So: EVERY hook registers always-on. It is one existsSync once registered.

// The SHIPPED artifact, not dist/. A plugin install is a git clone of
// plugin/, so plugin/bin/agentchat is literally the file users run — and the
// daemon bundle sits beside it, which is how `shippedDaemonPath()` finds it.
// Testing dist/index.js would exercise a layout that never reaches anyone.
const CLI = path.join(__dirname, '..', 'plugin', 'bin', 'agentchat')

let sandbox: string
const claudeHome = (): string => path.join(sandbox, '.claude')
const wanted = (): string => path.join(claudeHome(), 'agentchat', 'always-on.wanted')
const stableDaemon = (): string =>
  path.join(claudeHome(), 'agentchat', 'bin', 'agentchat-daemon.mjs')

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-midsession-'))
})
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }))

function hook(event: string, stdin = '{}'): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, 'hook', event],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: sandbox,
          CLAUDE_CONFIG_DIR: claudeHome(),
          AGENTCHAT_SERVICE_DRY_RUN: '1',
          AGENTCHAT_API_BASE: 'http://127.0.0.1:9',
          AGENTCHAT_LOG_LEVEL: 'silent',
        },
        timeout: 20_000,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
        resolve({ code: typeof e?.code === 'number' ? e.code : e ? 1 : 0, out: `${stdout}${stderr}` })
      },
    )
    child.stdin?.write(stdin)
    child.stdin?.end()
  })
}

describe('always-on survives an install that misses SessionStart', () => {
  for (const event of ['user-prompt', 'stop']) {
    it(`\`${event}\` alone is enough to register it`, async () => {
      expect(fs.existsSync(wanted()), 'precondition: nothing registered yet').toBe(false)
      const { code } = await hook(event)
      expect(code, 'a hook must never fail the session').toBe(0)
      expect(fs.existsSync(wanted()), 'always-on should be registered').toBe(true)
    })
  }

  it('session-start still registers it', async () => {
    await hook('session-start')
    expect(fs.existsSync(wanted())).toBe(true)
  })

  it('repeating hooks leaves exactly one registration', async () => {
    await hook('session-start')
    const first = fs.readFileSync(wanted(), 'utf-8')
    await hook('user-prompt')
    await hook('stop')
    // Re-registering would re-stamp the marker, and the marker's mtime is what
    // the startup grace reads — a constantly-refreshed marker would mask a
    // genuinely dead daemon forever.
    expect(fs.readFileSync(wanted(), 'utf-8')).toBe(first)
  })

  it('a later hook repairs a missing durable daemon instead of trusting the marker', async () => {
    await hook('session-start')
    expect(fs.existsSync(stableDaemon())).toBe(true)

    fs.unlinkSync(stableDaemon())
    const { code, out } = await hook('user-prompt')

    expect(code, out).toBe(0)
    expect(fs.existsSync(stableDaemon())).toBe(true)
    expect(
      fs.readFileSync(path.join(claudeHome(), 'agentchat', 'always-on.installed-version'), 'utf-8').trim(),
    ).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('the tested event names are the ones the plugin actually wires', () => {
    // A hook name that does not exist exits 1 with a usage error and registers
    // nothing — silently, since hooks are not allowed to fail a session. So the
    // names here are read from the shipped manifest rather than written twice.
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json'), 'utf-8')
    for (const e of ['session-start', 'user-prompt', 'stop']) {
      expect(manifest, `plugin should wire \`hook ${e}\``).toContain(`hook ${e}`)
    }
  })

  it('a deliberate opt-out is not undone by any hook', async () => {
    fs.mkdirSync(path.join(claudeHome(), 'agentchat'), { recursive: true })
    fs.writeFileSync(path.join(claudeHome(), 'agentchat', 'always-on.optout'), 'x')
    for (const e of ['session-start', 'user-prompt', 'stop']) await hook(e)
    expect(fs.existsSync(wanted()), 'off must stay off').toBe(false)
  })
})
