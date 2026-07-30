import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const json = (rel: string): Record<string, unknown> =>
  JSON.parse(read(rel)) as Record<string, unknown>

describe('the NPX package is internally consistent', () => {
  const pkg = json('package.json')
  const version = pkg['version'] as string

  it('publishes under the Claude Code front door', () => {
    expect(pkg['name']).toBe('@agentchatme/claude-code')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect((pkg['bin'] as Record<string, string>)['agentchat-claude-code']).toBe(
      './dist/index.js',
    )
  })

  it('src/version.ts matches package.json', () => {
    const match = read('src/version.ts').match(/VERSION\s*=\s*'([^']+)'/)
    expect(match?.[1]).toBe(version)
  })

  it('the built CLI reports the declared version', () => {
    expect(read('dist/index.js')).toContain(version)
  })

  it('publishes both standalone runtimes', () => {
    expect(fs.existsSync(path.join(ROOT, 'dist', 'index.js'))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, 'dist', 'daemon-main.js'))).toBe(true)
    expect(pkg['files']).toEqual(['dist', 'README.md', 'LICENSE'])
  })
})
