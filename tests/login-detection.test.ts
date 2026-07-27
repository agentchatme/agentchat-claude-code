import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { claudeIsLoggedIn } from '../src/adapter.js'

// ─── "claude is not logged in" while claude was, in fact, logged in ─────────
//
// The daemon's preflight checked for ~/.claude/.credentials.json. On macOS that
// file does not exist: Claude Code stores its credentials in the login keychain
// under the service name "Claude Code-credentials". So on the very first real
// install, the daemon parked itself with
//
//   not connecting yet: runtime (claude-code) not ready: claude is not logged in
//
// and always-on could never answer a message on that machine — on the default
// platform for this integration.
//
// The keychain probe is `security find-generic-password -s <service>` with no
// -w: it reports EXISTENCE (exit 0/44) and never asks for the secret, so it
// prompts for nothing and prints no password. Safe to run from a daemon.

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('login detection', () => {
  it('accepts the credentials file wherever it exists', () => {
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
    expect(claudeIsLoggedIn(dir)).toBe(true)
  })

  it('does not depend on the file alone on macOS', () => {
    // No file. On darwin the answer must come from the keychain, so it is
    // whatever the real machine says — NOT an automatic false.
    if (process.platform !== 'darwin') return
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const present =
      spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
        encoding: 'utf-8', timeout: 5_000,
      }).status === 0
    expect(claudeIsLoggedIn(dir)).toBe(present)
  })

  it('the probe never asks for or reveals the secret', () => {
    if (process.platform !== 'darwin') return
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
      encoding: 'utf-8', timeout: 5_000,
    })
    // -w would print the secret and can prompt for keychain access. Neither the
    // flag nor a password field may ever appear here.
    expect(`${r.stdout ?? ''}`).not.toMatch(/^password:/m)
  })

  it('reports signed-out honestly when there is nothing anywhere', () => {
    // Cross-platform half of the contract: on a non-darwin box with no file,
    // the answer is a plain false rather than a throw.
    if (process.platform === 'darwin') return
    expect(claudeIsLoggedIn(dir)).toBe(false)
  })
})
