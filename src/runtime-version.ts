export const MIN_CLAUDE_CODE_VERSION = '2.1.219'

export function semverAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.match(/(\d+)\.(\d+)\.(\d+)/)
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : null
  }
  const a = parse(actual)
  const b = parse(minimum)
  if (a === null || b === null) return false
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) > (b[index] ?? 0)
  }
  return true
}
