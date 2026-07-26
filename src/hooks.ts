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
 * clone. So the first session start is this integration's install hook, and
 * where always-on gets registered.
 *
 * It needs no credentials: the daemon is resident and idles until one appears.
 * It is a no-op once registered, and respects a deliberate `daemon disable`.
 * Failure is swallowed — a session must never break over this.
 */
export async function runSessionStart(): Promise<void> {
  try {
    const r = ensureAlwaysOn()
    if (!r.ok && r.detail !== 'switched off by the user') {
      log.warn(`always-on not registered: ${r.detail}`)
    }
  } catch (err) {
    log.warn(`always-on not registered: ${String(err)}`)
  }
  await runners.runSessionStart()
}

export const { runUserPrompt, runStop } = runners
