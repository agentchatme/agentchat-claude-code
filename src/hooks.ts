import { createHookRunners, log } from '@agentchatme/agent-core'
import { identityHome, hostCopy } from './host.js'
import { sessionStartOutput, stopOutput, printJson } from './dialect.js'
import { ensureAlwaysOn } from './always-on.js'

// ─── Session hooks ──────────────────────────────────────────────────────────
//
// agent-core decides WHAT the agent is told; ./dialect.ts decides HOW to say it
// to Claude Code. This file only joins the two. No host is selected at runtime
// — `identityHome()` is a constant of this package.
//
// The joining logic was duplicated per integration and the copies were
// byte-identical, so it lives in the engine now. The invariant it carries is
// unchanged: exit code is ALWAYS 0. A failing hook degrades to "no AgentChat
// context this turn", never to a broken session.

const runners = createHookRunners(
  () => ({ home: identityHome(), copy: hostCopy() }),
  { sessionStartOutput, stopOutput, printJson },
)

/**
 * Claude Code runs no code when a plugin is installed — an install is a git
 * clone — so a hook is the only place always-on can be registered.
 *
 * It runs on EVERY hook, not just session start. Installing a plugin
 * mid-session is the normal case, and Claude Code loads the new hooks for
 * later events in that session but never re-fires SessionStart. A
 * session-start-only registration therefore silently skipped the whole feature
 * until the user happened to open a fresh session — which is exactly what
 * happened on the first real install.
 *
 * It needs no credentials, is a no-op once registered (one `existsSync`), and
 * respects a deliberate `daemon disable`. Failure is swallowed — a session must
 * never break over this.
 */
function ensureAlwaysOnQuietly(): void {
  try {
    const r = ensureAlwaysOn()
    if (!r.ok && r.detail !== 'switched off by the user') {
      log.warn(`always-on not registered: ${r.detail}`)
    }
  } catch (err) {
    log.warn(`always-on not registered: ${String(err)}`)
  }
}

export async function runSessionStart(): Promise<void> {
  ensureAlwaysOnQuietly()
  await runners.runSessionStart()
}

export async function runUserPrompt(): Promise<void> {
  ensureAlwaysOnQuietly()
  await runners.runUserPrompt()
}

export async function runStop(): Promise<void> {
  ensureAlwaysOnQuietly()
  await runners.runStop()
}
