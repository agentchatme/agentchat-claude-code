// ─── Claude Code's hook JSON dialect ────────────────────────────────────────
//
// How THIS host wants hook output shaped. Every coding agent expects a
// different envelope, so each integration owns its own rather than a shared
// module choosing between them.
//
// Verified 2026-07-07: SessionStart carries additionalContext via
// hookSpecificOutput; Stop continues with {decision:"block", reason}.

export function sessionStartOutput(
  context: string,
  notification: string | null = null,
): Record<string, unknown> {
  return {
    ...(notification === null ? {} : { systemMessage: notification }),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }
}

export function userPromptOutput(
  context: string,
  notification: string | null = null,
): Record<string, unknown> {
  return {
    ...(notification === null ? {} : { systemMessage: notification }),
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }
}

export function stopOutput(reason: string): Record<string, unknown> {
  return { decision: 'block', reason }
}

export function printJson(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + '\n')
}
