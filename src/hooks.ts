import { createHookRunners } from '@agentchatme/agent-core'
import { identityHome, hostCopy } from './host.js'
import { sessionStartOutput, stopOutput, printJson } from './dialect.js'

// ─── Session hooks ──────────────────────────────────────────────────────────
//
// agent-core decides WHAT the agent is told; ./dialect.ts decides HOW to say it
// to Claude Code. This file only joins the two. No host is selected at runtime
// — `identityHome()` is a constant of this package.
//
// The joining logic was duplicated per integration and the copies were
// byte-identical, down to a comment in this one describing how it talks to
// Codex. It lives in the engine now.

export const { runSessionStart, runUserPrompt, runStop } = createHookRunners(
  () => ({ home: identityHome(), copy: hostCopy() }),
  { sessionStartOutput, stopOutput, printJson },
)
