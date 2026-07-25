import { sessionStart, userPrompt, stop, readHookInput, log, type HookContext } from '@agentchatme/agent-core'
import { identityHome, hostCopy } from './host.js'
import { sessionStartOutput, stopOutput, printJson } from './dialect.js'

// ─── Session hooks ──────────────────────────────────────────────────────────
//
// Thin: agent-core decides WHAT the agent is told, this file decides HOW to
// say it to Codex. No host is selected at runtime — `identityHome()` is a
// constant of this package.
//
// Invariant preserved from the engine: exit code is ALWAYS 0. A failing hook
// degrades to "no AgentChat context this turn", never to a broken session.
// Diagnostics go to stderr only; stdout carries one JSON object or nothing.

function ctx(): HookContext {
  return { home: identityHome(), copy: hostCopy() }
}

export async function runSessionStart(): Promise<void> {
  try {
    const input = await readHookInput()
    const { context } = await sessionStart(ctx(), input)
    if (context !== null) printJson(sessionStartOutput(context))
  } catch (err) {
    log.warn(`session-start hook degraded to no-op: ${String(err)}`)
  }
}

export async function runUserPrompt(): Promise<void> {
  try {
    const input = await readHookInput()
    await userPrompt(ctx(), input)
  } catch (err) {
    log.warn(`user-prompt hook degraded to no-op: ${String(err)}`)
  }
}

export async function runStop(): Promise<void> {
  try {
    const input = await readHookInput()
    const { reason, commit } = await stop(ctx(), input)
    if (reason === null) return
    // Print FIRST, commit second: the ack means "the agent has this", so a
    // failed print must not leave the message marked delivered. The engine
    // hands back `commit` precisely so this ordering lives at the call site.
    printJson(stopOutput(reason))
    await commit()
  } catch (err) {
    log.warn(`stop hook degraded to no-op: ${String(err)}`)
  }
}
