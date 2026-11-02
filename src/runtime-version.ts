/**
 * Two flags the doorbell relies on set the floor:
 *   * `--permission-prompts none` — a headless run denies every prompt instead
 *     of waiting on one. Claude Code v2.1.259 (CHANGELOG 2.1.259;
 *     code.claude.com/docs/en/cli-reference.md).
 *   * `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` — bounds how long the first
 *     non-interactive turn waits for the MCP servers `--allowedTools` names to
 *     connect. Added in v2.1.274 (CHANGELOG 2.1.274: "Added
 *     CLAUDE_CODE_MCP_STARTUP_WAIT_MS to bound how long the first
 *     non-interactive turn waits for connecting MCP servers"). Without it a
 *     run could start before the hosted inbox tool is there.
 * The floor is the later one. Everything else the doorbell passes (`-p`,
 * `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--tools`,
 * `--no-session-persistence`, `--output-format`) predates both.
 */
export const MIN_CLAUDE_CODE_VERSION = '2.1.274'

export function semverAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.match(/(\d+)\.(\d+)\.(\d+)/)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
  }
  const a = parse(actual)
  const b = parse(minimum)
  if (a === null || b === null) return false
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) > (b[index] ?? 0)
  }
  return true
}
