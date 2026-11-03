import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildDoorbellPrompts, manualPointer, mcpToolNamer, wakeInstruction } from '@agentchatme/agent-core'
import { ClaudeRunner, buildClaudeEnv } from '../src/runner.js'
import { AGENTCHAT_TOOL_ALLOW, claudeRunArgs, readDenyRules } from '../src/profile.js'
import { claudeUserStatePathFor, identityHomeFor } from '../src/host.js'
import { installFakeClaude, readRuns, type FakeClaude } from './helpers/fake-claude.js'

// ─── One headless Claude Code run: the exact flags, the prompt on stdin ─────

let sandbox: string
let fake: FakeClaude
let workdir: string
const originalPath = process.env['PATH']

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-runner-'))
  fake = installFakeClaude(sandbox)
  workdir = path.join(sandbox, 'workdir')
  process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
})
afterEach(() => {
  process.env['PATH'] = originalPath
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  FAKE_CLAUDE_RECORD: fake.recordPath,
  ...extra,
})

describe('the permission profiles, as Claude Code flags', () => {
  it('answer: read-only built-ins + web + every hosted tool, prompts denied, Manual mode', () => {
    expect(claudeRunArgs('answer')).toEqual([
      '-p',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--permission-mode',
      'default',
      '--permission-prompts',
      'none',
      '--tools',
      'Read,Glob,Grep,WebSearch,WebFetch',
      '--allowedTools',
      'mcp__agentchat__*,Read,Glob,Grep,WebSearch,WebFetch',
    ])
  })

  it('work: edits and shell pre-approved, acceptEdits, prompts denied', () => {
    expect(claudeRunArgs('work')).toEqual([
      '-p',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--allowedTools',
      'mcp__agentchat__*,Read,Glob,Grep,WebSearch,WebFetch,Bash,Edit,Write,MultiEdit,NotebookEdit',
    ])
  })

  it('full: the runtime’s bypass, prompts still denied rather than waited on', () => {
    expect(claudeRunArgs('full')).toEqual([
      '-p',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
      '--permission-prompts',
      'none',
      '--allowedTools',
      'mcp__agentchat__*',
    ])
  })

  it('every profile pre-approves the whole hosted server and denies prompts', () => {
    for (const profile of ['answer', 'work', 'full'] as const) {
      const args = claudeRunArgs(profile)
      expect(args).toContain('--permission-prompts')
      expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none')
      expect(args[args.indexOf('--allowedTools') + 1]).toContain(AGENTCHAT_TOOL_ALLOW)
      expect(args).not.toContain('--mcp-config') // the user-scope registration IS the tool source
    }
  })

  it('an optional spend cap is passed only when it is a number', () => {
    expect(claudeRunArgs('answer', { maxBudgetUsd: '2.50' })).toContain('--max-budget-usd')
    expect(claudeRunArgs('answer', { maxBudgetUsd: 'lots' })).not.toContain('--max-budget-usd')
  })

  it('the key store is denied to the run’s file tools: Read deny rules for the identity home and ~/.claude.json, last on the line', () => {
    const rules = readDenyRules(['/Users/x/.claude/agentchat', '/Users/x/.claude.json'])
    if (process.platform === 'win32') {
      expect(rules).toEqual([])
      return
    }
    expect(rules).toEqual([
      'Read(//Users/x/.claude/agentchat)',
      'Read(//Users/x/.claude/agentchat/**)',
      'Read(//Users/x/.claude.json)',
      'Read(//Users/x/.claude.json/**)',
    ])
    for (const profile of ['answer', 'work', 'full'] as const) {
      const args = claudeRunArgs(profile, { denyReadPaths: ['/Users/x/.claude/agentchat', '/Users/x/.claude.json'] })
      expect(args.at(-2)).toBe('--disallowedTools')
      expect(args.at(-1)).toBe(rules.join(','))
      expect(args.slice(0, -2)).toEqual(claudeRunArgs(profile))
    }
    // Paths the comma/space list cannot carry are skipped rather than mangled; relative paths too.
    expect(readDenyRules(['/with space/x', '/with,comma', 'relative/path'])).toEqual([])
  })
})

describe('the child environment', () => {
  it('strips the parent session’s sentinels and bounds the MCP startup wait', () => {
    const out = buildClaudeEnv(undefined, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CONFIG_DIR: '/elsewhere', PATH: '/bin' })
    expect(out['CLAUDECODE']).toBeUndefined()
    expect(out['CLAUDE_CODE_SESSION_ID']).toBeUndefined()
    expect(out['CLAUDE_CONFIG_DIR']).toBeUndefined() // unset is not ~/.claude
    expect(out['DISABLE_AUTOUPDATER']).toBe('1')
    expect(out['CLAUDE_CODE_MCP_STARTUP_WAIT_MS']).toBe('15000')
    expect(out['PATH']).toBe('/bin')
  })

  it('keeps an explicit config dir and a larger startup wait', () => {
    const out = buildClaudeEnv('/custom', { CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '60000' })
    expect(out['CLAUDE_CONFIG_DIR']).toBe('/custom')
    expect(out['CLAUDE_CODE_MCP_STARTUP_WAIT_MS']).toBe('60000')
  })
})

describe('ClaudeRunner', () => {
  const prompts = buildDoorbellPrompts({ toolName: mcpToolNamer('agentchat'), manualPointer: manualPointer('at ~/.claude/skills/agentchat/SKILL.md') })

  it('preflight passes with a current, signed-in claude', async () => {
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', env: env() })
    expect(await runner.preflight()).toEqual({ ok: true })
    expect(fs.existsSync(workdir)).toBe(true)
  })

  it('preflight fails when claude is signed out', async () => {
    process.env['FAKE_CLAUDE_LOGGED_OUT'] = '1'
    try {
      const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', env: env() })
      expect(await runner.preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/not signed in/) })
    } finally {
      delete process.env['FAKE_CLAUDE_LOGGED_OUT']
    }
  })

  it('preflight fails on a claude older than the floor (2.1.274: --permission-prompts none AND CLAUDE_CODE_MCP_STARTUP_WAIT_MS)', async () => {
    fake = installFakeClaude(sandbox, '2.1.273')
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', env: env() })
    expect(await runner.preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/>= 2\.1\.274/) })
  })

  it('a knock run: the server’s wake text on stdin, the profile flags, the workdir, the scrubbed env — output discarded', async () => {
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', env: env({ CLAUDECODE: '1' }) })
    fs.mkdirSync(workdir, { recursive: true })
    const outcome = await runner.start({ kind: 'knock', prompt: prompts.knock, runId: 'r1', budgetMs: 10_000 })
    expect(outcome).toMatchObject({ state: 'ok', exitCode: 0 })
    expect(JSON.stringify(outcome)).not.toContain('Peer text')

    const runs = readRuns(fake)
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    // The profile flags, then the key-store deny rules for THIS config dir.
    expect(run.argv).toEqual(claudeRunArgs('answer', { denyReadPaths: [identityHomeFor(undefined), claudeUserStatePathFor(undefined)] }))
    if (process.platform !== 'win32') {
      expect(run.argv.at(-2)).toBe('--disallowedTools')
      expect(run.argv.at(-1)).toContain(`Read(/${identityHomeFor(undefined)}/**)`)
      expect(run.argv.at(-1)).toContain(`Read(/${claudeUserStatePathFor(undefined)})`)
    }
    expect(run.stdin).toBe(prompts.knock)
    expect(run.stdin.startsWith(wakeInstruction(mcpToolNamer('agentchat')))).toBe(true)
    expect(run.stdin).toContain('mcp__agentchat__agentchat_inbox')
    expect(run.stdin).not.toMatch(/gate step/i)
    expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(workdir))
    expect(run.env['CLAUDECODE']).toBeUndefined()
    expect(run.env['DISABLE_AUTOUPDATER']).toBe('1')
    expect(run.env['CLAUDE_CODE_MCP_STARTUP_WAIT_MS']).toBe('15000')
  })

  it('an invite run uses the invite prompt', async () => {
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'work', env: env() })
    fs.mkdirSync(workdir, { recursive: true })
    await runner.start({ kind: 'invite', prompt: prompts.invite, runId: 'r2', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    expect(run.stdin).toBe(prompts.invite)
    expect(run.argv).toEqual(claudeRunArgs('work', { denyReadPaths: [identityHomeFor(undefined), claudeUserStatePathFor(undefined)] }))
  })

  it('a relocated config dir moves the deny rules with it', async () => {
    const relocated = path.join(sandbox, 'relocated')
    fs.mkdirSync(relocated, { recursive: true })
    const runner = new ClaudeRunner({ configDir: relocated, workdir, profile: 'answer', env: env() })
    fs.mkdirSync(workdir, { recursive: true })
    await runner.start({ kind: 'knock', prompt: 'P', runId: 'r3', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    if (process.platform !== 'win32') {
      expect(run.argv.at(-1)).toContain(`Read(/${path.join(relocated, 'agentchat')}/**)`)
      expect(run.argv.at(-1)).toContain(`Read(/${path.join(relocated, '.claude.json')})`)
    }
  })

  it('the doorbell stopping aborts the run: the signal reaches spawnRun and the process group is gone', async () => {
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', env: env({ FAKE_CLAUDE_RUN: 'hang' }) })
    fs.mkdirSync(workdir, { recursive: true })
    const controller = new AbortController()
    const pending = runner.start({ kind: 'knock', prompt: 'P', runId: 'r4', budgetMs: 60_000, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 400))
    controller.abort()
    const outcome = await pending
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toMatch(/interrupted/)
  }, 15_000)

  it('classifies: a failure after output is failed, a silent non-zero exit is not_started, a hang is timed_out', async () => {
    fs.mkdirSync(workdir, { recursive: true })
    const request = { kind: 'knock' as const, prompt: 'P', runId: 'r', budgetMs: 15_000 }

    const failed = await new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', env: env({ FAKE_CLAUDE_RUN: 'fail' }) }).start(request)
    expect(failed).toMatchObject({ state: 'failed', exitCode: 1 })
    expect(failed.detail).toContain('the fake runtime failed')

    const nostart = await new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', env: env({ FAKE_CLAUDE_RUN: 'nostart' }) }).start(request)
    expect(nostart).toMatchObject({ state: 'not_started', exitCode: 2 })

    // README § Verify step 8: a signed-out Claude Code complains on stderr and exits — `run not_started`, complaint attached.
    const signedOut = await new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', env: env({ FAKE_CLAUDE_RUN: 'signedout' }) }).start(request)
    expect(signedOut).toMatchObject({ state: 'not_started', exitCode: 1 })
    expect(signedOut.detail).toMatch(/nothing on stdout: Not logged in/)

    const hang = await new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', env: env({ FAKE_CLAUDE_RUN: 'hang' }) }).start({ ...request, budgetMs: 1_500 })
    expect(hang.state).toBe('timed_out')
  }, 40_000)

  it('a missing claude binary is not_started, never a throw', async () => {
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', command: path.join(sandbox, 'no-such-claude'), env: env() })
    fs.mkdirSync(workdir, { recursive: true })
    expect((await runner.start({ kind: 'knock', prompt: 'P', runId: 'r', budgetMs: 1_000 })).state).toBe('not_started')
  })
})
