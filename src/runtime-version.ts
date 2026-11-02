/**
 * `--permission-prompts none` — the flag that lets a headless run deny every
 * prompt instead of waiting on one — requires Claude Code v2.1.259 or later
 * (code.claude.com/docs/en/cli-reference.md; CHANGELOG 2.1.259). Everything
 * else the doorbell passes (`-p`, `--permission-mode`, `--allowedTools`,
 * `--tools`, `--no-session-persistence`, `--output-format`) predates it.
 */
export const MIN_CLAUDE_CODE_VERSION = '2.1.259'

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
