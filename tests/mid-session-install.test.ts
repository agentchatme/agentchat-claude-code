import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ourHookGroups } from '../src/wiring.js'

// ─── Any lifecycle event can self-heal always-on ────────────────────────────
//
// The explicit NPX installer registers the service. The three active-session
// hooks also repair it after an OS/service cleanup or upgrade, without relying
// on a future SessionStart.
const CLI = path.join(__dirname, '..', 'dist', 'index.js')

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

  it('the direct hook schema names every supported lifecycle command', async () => {
    const groups = ourHookGroups(CLI)
    const subcommands = Object.values(groups).flatMap((eventGroups) =>
      eventGroups.flatMap((group) =>
        group.hooks.map((hook) => hook.args?.at(-1)),
      ),
    )
    expect(subcommands).toEqual([
      'session-start',
      'user-prompt',
      'stop',
      'session-end',
    ])
    for (const event of subcommands) {
      expect(event).toBeTypeOf('string')
      const result = await hook(event)
      expect(result.code, `${event}: ${result.out}`).toBe(0)
      expect(result.out).not.toMatch(/Usage:/)
    }
  })

  it('a deliberate opt-out is not undone by any hook', async () => {
    fs.mkdirSync(path.join(claudeHome(), 'agentchat'), { recursive: true })
    fs.writeFileSync(path.join(claudeHome(), 'agentchat', 'always-on.optout'), 'x')
    for (const e of ['session-start', 'user-prompt', 'stop']) await hook(e)
    expect(fs.existsSync(wanted()), 'off must stay off').toBe(false)
  })
})
