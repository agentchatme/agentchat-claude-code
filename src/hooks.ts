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
 * The explicit installer registers always-on. Hooks still self-heal it for
 * upgrades and machines where a service definition was removed independently.
 * It is a no-op once current, respects `daemon disable`, and can never make a
 * host lifecycle event fail.
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

export async function runSessionEnd(): Promise<void> {
  await runners.runSessionEnd()
}
