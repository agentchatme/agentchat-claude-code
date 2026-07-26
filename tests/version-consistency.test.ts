import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── One version, stated in four places ─────────────────────────────────────
//
// This plugin carries its version in package.json, src/version.ts,
// plugin/.claude-plugin/plugin.json and .claude-plugin/marketplace.json (twice).
// None is generated from another, so they drift silently — and the one users
// see in the marketplace is not the one `--version` prints.
//
// Bumping is deliberately slow here (0.0.1391 → 0.0.1392: increment the last
// digit, append a new one only when it reaches 9), which means the numbers are
// long and easy to fat-finger. Cheaper to assert than to notice in the wild.

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const json = (rel: string): Record<string, unknown> => JSON.parse(read(rel)) as Record<string, unknown>

describe('every declared version agrees', () => {
  const pkg = json('package.json')['version'] as string

  it('package.json has a version', () => {
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('src/version.ts matches package.json', () => {
    const m = read('src/version.ts').match(/VERSION\s*=\s*'([^']+)'/)
    expect(m?.[1]).toBe(pkg)
  })

  it('the plugin manifest matches package.json', () => {
    expect(json('plugin/.claude-plugin/plugin.json')['version']).toBe(pkg)
  })

  it('the marketplace entry matches package.json', () => {
    const mp = json('.claude-plugin/marketplace.json')
    const plugins = mp['plugins'] as Array<Record<string, unknown>>
    expect((mp['metadata'] as Record<string, unknown>)['version']).toBe(pkg)
    expect(plugins[0]?.['version']).toBe(pkg)
  })

  it('the committed bundle reports it', () => {
    // The bundle is what actually runs; a stale stamp means `--version` lies.
    expect(read('plugin/bin/agentchat')).toContain(pkg)
  })
})
