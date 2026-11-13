import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { claudeIsLoggedIn } from '../src/runner.js'
import { installFakeClaude } from './helpers/fake-claude.js'

// ─── "claude is not logged in" while claude was, in fact, logged in ─────────
//
// The daemon's preflight once checked for ~/.claude/.credentials.json. On
// macOS that file does not exist: Claude Code stores its credentials in the
// login keychain. So the daemon parked itself forever on the default platform.
//
// `claude auth status` is the answer now (JSON with a boolean `loggedIn`); the
// file and the existence-only keychain probe (`security find-generic-password`
// without `-w`: never prompts, never prints the secret) remain the fallback for
// builds without the subcommand.

let dir: string
let fakeBin: string
const originalPath = process.env['PATH']

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-'))
  fakeBin = installFakeClaude(dir).binDir
  process.env['PATH'] = `${fakeBin}${path.delimiter}${originalPath ?? ''}`
})
afterEach(() => {
  process.env['PATH'] = originalPath
  delete process.env['FAKE_CLAUDE_LOGGED_OUT']
  fs.rmSync(dir, { recursive: true, force: true })
})

const MISSING = path.join(os.tmpdir(), 'no-such-claude-binary')

describe('login detection', () => {
  it('trusts `claude auth status` when it answers with JSON', async () => {
    expect(await claudeIsLoggedIn(dir)).toBe(true)
    process.env['FAKE_CLAUDE_LOGGED_OUT'] = '1'
    // Even with a stray credentials file: the CLI's answer is authoritative.
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
    expect(await claudeIsLoggedIn(dir)).toBe(false)
  })

  it('falls back to the credentials file when the CLI cannot answer', async () => {
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
    expect(await claudeIsLoggedIn(dir, MISSING)).toBe(true)
  })

  it('does not depend on the file alone on macOS', async () => {
    // No file, no CLI answer. On darwin the fallback is the keychain, so it is
    // whatever the real machine says — NOT an automatic false.
    if (process.platform !== 'darwin') return
    const present =
      spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { encoding: 'utf-8', timeout: 5_000 }).status === 0
    expect(await claudeIsLoggedIn(dir, MISSING)).toBe(present)
  })

  it('the keychain probe never asks for or reveals the secret', () => {
    if (process.platform !== 'darwin') return
    const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { encoding: 'utf-8', timeout: 5_000 })
    // -w would print the secret and can prompt for keychain access. Neither the
    // flag nor a password field may ever appear here.
    expect(`${r.stdout ?? ''}`).not.toMatch(/^password:/m)
  })

  it('reports signed-out honestly when there is nothing anywhere', async () => {
    if (process.platform === 'darwin') return
    expect(await claudeIsLoggedIn(dir, MISSING)).toBe(false)
  })
})
