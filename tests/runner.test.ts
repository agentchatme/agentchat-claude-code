import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { hostedMcpUrl, manualPointer, PEER_RUN_WARNING } from '@agentchatme/agent-core'
import { AGENTCHAT_TOOL_ALLOW, claudeProjectsDirFor, claudeRunArgs, readDenyRules, workdirReadRules } from '@agentchatme/agent-core/presets'
import { ClaudeRunner, answerToolConfigFor, buildClaudeEnv, deniedAncestorOf, denyReadPathsFor, profileNote, removeAnswerRunFiles, runPointer } from '../src/runner.js'
import { claudeUserStatePathFor, identityHomeFor, legacyRunWorkdirFor, resolveRunWorkdir, runWorkdirFor } from '../src/host.js'
import { VERSION } from '../src/version.js'
import { installFakeClaude, readRuns, type FakeClaude, type FakeMcpConfig } from './helpers/fake-claude.js'

// ─── One headless Claude Code run: the exact flags, the prompt on stdin ─────
//
// HOME is a sandbox for every test here: the runner reads Claude Code's own
// settings files (`~/.claude/settings.json`) before an answer run, writes an
// answer run's tool config into the identity home, and reads the key there.
// None of that may ever be the developer's real `~/.claude`.

let sandbox: string
let fakeHome: string
let fake: FakeClaude
let workdir: string
const originalPath = process.env['PATH']
/** What the runner reads from the process environment, cleared for each test and put back after. */
const SCRUBBED = ['HOME', 'USERPROFILE', 'AGENTCHAT_API_KEY', 'AGENTCHAT_API_BASE', 'CLAUDE_CONFIG_DIR', 'AGENTCHAT_RUN_PROFILE', 'AGENTCHAT_RUN_CWD', 'AGENTCHAT_RUN_MAX_BUDGET_USD'] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-runner-')))
  fakeHome = path.join(sandbox, 'home')
  fs.mkdirSync(fakeHome, { recursive: true })
  saved = Object.fromEntries(SCRUBBED.map((key) => [key, process.env[key]]))
  for (const key of SCRUBBED) delete process.env[key]
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  fake = installFakeClaude(sandbox)
  workdir = path.join(sandbox, 'workdir')
  process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
})
afterEach(() => {
  process.env['PATH'] = originalPath
  for (const key of SCRUBBED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  FAKE_CLAUDE_RECORD: fake.recordPath,
  ...extra,
})

const API_BASE = 'https://api.agentchat.test'
const KEY = 'ac_live_' + 'k'.repeat(40)
const OTHER_KEY = 'ac_live_' + 'r'.repeat(40)
const IDENTITY_LINE = 'I am @cc-agent on AgentChat (api.agentchat.me). Served identity line for claude-code.'
const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex')

/** Sign the identity home in, as `register` / `login` leave it. */
function signIn(home: string, key: string = KEY): void {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: key, handle: 'cc-agent', api_base: API_BASE }), { mode: 0o600 })
}

/** The files an answer run wrote for itself and has not removed. */
function runFilesLeft(home: string): string[] {
  const dir = path.dirname(answerToolConfigFor(home))
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('claude-code.mcp.') || name.startsWith('.claude-code.mcp.')) : []
}

const ANSWER_SETTINGS_JSON = '{"permissions":{"blockReadsOutsideWorkingDirectories":true},"env":{"CLAUDE_CODE_DISABLE_CLAUDE_MDS":"1","CLAUDE_CODE_DISABLE_AUTO_MEMORY":"1"},"disableAllHooks":true}'

describe('the permission profiles, as Claude Code flags', () => {
  it('answer: Read/Glob/Grep only, prompts denied, Manual mode, reads blocked outside the working directories, no CLAUDE.md, memory or hooks, the web and the shell denied by name', () => {
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
      'Read,Glob,Grep',
      '--allowedTools',
      'mcp__agentchat__*',
      '--settings',
      ANSWER_SETTINGS_JSON,
      '--disallowedTools',
      'WebFetch,WebSearch,Bash',
    ])
  })

  it('answer, as a run gets it: its own AgentChat-only tool config (strict), its identity line, reads on its work folder alone, the key store and every project record denied', () => {
    const args = claudeRunArgs('answer', {
      workdir: '/w',
      mcpConfigPath: '/h/presets/claude-code.mcp.r1.json',
      appendSystemPromptFile: '/h/presets/claude-code.mcp.r1.identity.md',
      denyReadPaths: ['/h', '/Users/x/.claude.json', '/Users/x/.claude/projects'],
    })
    const win = process.platform === 'win32'
    expect(args).toEqual([
      '-p',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--mcp-config',
      '/h/presets/claude-code.mcp.r1.json',
      '--strict-mcp-config',
      '--append-system-prompt-file',
      '/h/presets/claude-code.mcp.r1.identity.md',
      '--permission-mode',
      'default',
      '--permission-prompts',
      'none',
      '--tools',
      'Read,Glob,Grep',
      '--allowedTools',
      win ? 'mcp__agentchat__*' : 'mcp__agentchat__*,Read(//w),Read(//w/**)',
      '--settings',
      ANSWER_SETTINGS_JSON,
      '--disallowedTools',
      win
        ? 'WebFetch,WebSearch,Bash'
        : 'WebFetch,WebSearch,Bash,Read(//h),Read(//h/**),Read(//Users/x/.claude.json),Read(//Users/x/.claude.json/**),Read(//Users/x/.claude/projects),Read(//Users/x/.claude/projects/**)',
    ])
  })

  it('REGRESSION GUARD: an answer run never gains the web, the shell, an edit tool, or a bare (every-path) read rule', () => {
    const args = claudeRunArgs('answer', { workdir: '/w', denyReadPaths: ['/h'] })
    const value = (flag: string): string[] => (args[args.indexOf(flag) + 1] ?? '').split(',')
    for (const tool of ['WebFetch', 'WebSearch', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(value('--tools')).not.toContain(tool)
      expect(value('--allowedTools')).not.toContain(tool)
    }
    for (const bare of ['Read', 'Glob', 'Grep']) expect(value('--allowedTools')).not.toContain(bare)
    expect(value('--disallowedTools').slice(0, 3)).toEqual(['WebFetch', 'WebSearch', 'Bash'])
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('acceptEdits')
  })

  it('work: edits, shell and the web pre-approved, acceptEdits, prompts denied', () => {
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
      expect(args).not.toContain('--mcp-config') // a tool config is the runner's to pass (an answer run's own; below)
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
      // answer denies the web and the shell by name first; the key store follows in every profile.
      expect(args.at(-1)).toBe(profile === 'answer' ? `WebFetch,WebSearch,Bash,${rules.join(',')}` : rules.join(','))
      expect(args.slice(0, -1)).toEqual(profile === 'answer' ? claudeRunArgs(profile).slice(0, -1) : claudeRunArgs(profile).concat('--disallowedTools'))
    }
    // Paths the comma/space list cannot carry are skipped rather than mangled; relative paths too.
    expect(readDenyRules(['/with space/x', '/with,comma', 'relative/path'])).toEqual([])
  })
})

describe('the child environment', () => {
  it('strips the parent session’s sentinels and bounds the MCP startup wait', () => {
    const out = buildClaudeEnv(undefined, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CONFIG_DIR: '/elsewhere', PATH: '/bin' })
    expect(out['CLAUDECODE']).toBeUndefined()
    expect(out['CLAUDE_CODE_SESSION_ID']).toBeUndefined()
    expect(out['CLAUDE_CODE_MESSAGING_TOKEN']).toBeUndefined()
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

  it('an answer run loads no CLAUDE.md and no auto memory; work and full keep the user’s own', () => {
    const answer = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env() }).runEnv()
    expect(answer['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBe('1')
    expect(answer['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
    for (const profile of ['work', 'full'] as const) {
      const out = new ClaudeRunner({ configDir: undefined, workdir, profile, apiBase: API_BASE, env: env() }).runEnv()
      expect(out['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBeUndefined()
      expect(out['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBeUndefined()
    }
  })
})

describe('ClaudeRunner', () => {
  // The served wake instruction (GET /v1/texts?runtime=claude-code) plus the pointer line, as the daemon builds it.
  const SERVED_WAKE = 'SERVED WAKE INSTRUCTION for claude-code: call mcp__agentchat__agentchat_inbox first.'
  const prompts = { wake: `${SERVED_WAKE}\n\n${manualPointer('at ~/.claude/skills/agentchat/SKILL.md')}`, invite: 'SERVED INVITE PROMPT' }

  it('preflight passes with a current, signed-in claude', async () => {
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env() })
    expect(await runner.preflight()).toEqual({ ok: true })
    expect(fs.existsSync(workdir)).toBe(true)
  })

  it('preflight fails when claude is signed out', async () => {
    process.env['FAKE_CLAUDE_LOGGED_OUT'] = '1'
    try {
      const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env() })
      expect(await runner.preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/not signed in/) })
    } finally {
      delete process.env['FAKE_CLAUDE_LOGGED_OUT']
    }
  })

  it('preflight fails on a claude older than the floor (2.1.274: --permission-prompts none AND CLAUDE_CODE_MCP_STARTUP_WAIT_MS)', async () => {
    fake = installFakeClaude(sandbox, '2.1.273')
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env() })
    expect(await runner.preflight()).toMatchObject({ ok: false, detail: expect.stringMatching(/>= 2\.1\.274/) })
  })

  it('an answer wake run: the served wake text on stdin, its own AgentChat-only tool config with THIS agent’s key, its identity line, the scrubbed env — both files gone after it, output discarded', async () => {
    const home = identityHomeFor(undefined)
    expect(home).toBe(path.join(fakeHome, '.claude', 'agentchat')) // the sandbox, never the real ~/.claude
    signIn(home)
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent' }) })
    fs.mkdirSync(workdir, { recursive: true })
    const outcome = await runner.start({ kind: 'wake', prompt: prompts.wake, runId: 'r1', identityLine: IDENTITY_LINE, budgetMs: 10_000 })
    expect(outcome).toMatchObject({ state: 'ok', exitCode: 0 })
    expect(JSON.stringify(outcome)).not.toContain('Peer text')

    const runs = readRuns(fake)
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    const toolConfig = path.join(home, 'presets', 'claude-code.mcp.r1.json')
    const identityFile = path.join(home, 'presets', 'claude-code.mcp.r1.identity.md')
    // The answer flags, with this run's own files, its work folder, and the key store plus every project record denied.
    expect(run.argv).toEqual(
      claudeRunArgs('answer', {
        workdir,
        mcpConfigPath: toolConfig,
        appendSystemPromptFile: identityFile,
        denyReadPaths: [home, claudeUserStatePathFor(undefined), claudeProjectsDirFor(undefined)],
      }),
    )
    expect(run.argv.slice(run.argv.indexOf('--mcp-config'), run.argv.indexOf('--mcp-config') + 3)).toEqual(['--mcp-config', toolConfig, '--strict-mcp-config'])
    if (process.platform !== 'win32') {
      expect(run.argv[run.argv.indexOf('--allowedTools') + 1]).toBe(['mcp__agentchat__*', ...workdirReadRules(workdir)].join(','))
      expect(run.argv.at(-1)).toContain(`Read(/${home}/**)`)
      expect(run.argv.at(-1)).toContain(`Read(/${claudeUserStatePathFor(undefined)})`)
      expect(run.argv.at(-1)).toContain(`Read(/${claudeProjectsDirFor(undefined)}/**)`)
    }
    // What the run's tool config held while it ran: the hosted server alone, THIS agent's key, the client headers.
    const config = run.mcpConfig as FakeMcpConfig
    expect(config).toMatchObject({
      servers: ['agentchat'],
      type: 'http',
      url: hostedMcpUrl(API_BASE),
      authorizationSha256: sha256(`Bearer ${KEY}`),
      client: 'claude-code',
      clientVersion: VERSION,
    })
    expect(config.headerNames.sort()).toEqual(['Authorization', 'X-AgentChat-Client', 'X-AgentChat-Client-Version'])
    if (process.platform !== 'win32') expect(config.mode).toBe(0o600)
    // Who it is comes from the served texts, not from a CLAUDE.md it does not load.
    expect(run.appendedSystemPrompt).toBe(`${IDENTITY_LINE}\n`)
    expect(run.stdin).toBe(prompts.wake)
    expect(run.stdin.startsWith(SERVED_WAKE)).toBe(true)
    expect(run.stdin).not.toMatch(/gate step/i)
    expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(workdir))
    expect(run.env['CLAUDECODE']).toBeUndefined()
    expect(run.env['CLAUDE_CODE_SESSION_ID']).toBeUndefined()
    expect(run.env['AGENTCHAT_API_KEY']).toBeUndefined() // the key reaches the run in its tool config only
    expect(run.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBe('1')
    expect(run.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
    expect(run.env['DISABLE_AUTOUPDATER']).toBe('1')
    expect(run.env['CLAUDE_CODE_MCP_STARTUP_WAIT_MS']).toBe('15000')
    // Removed when the run ended: no key file is left behind.
    expect(runFilesLeft(home)).toEqual([])
  })

  it('an answer run follows the credential: the key in the identity file when it starts; none (signed out) is no run at all', async () => {
    const home = identityHomeFor(undefined)
    signIn(home, KEY)
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env() })
    fs.mkdirSync(workdir, { recursive: true })
    expect((await runner.start({ kind: 'wake', prompt: 'P', runId: 'k1', budgetMs: 10_000 })).state).toBe('ok')
    signIn(home, OTHER_KEY)
    expect((await runner.start({ kind: 'wake', prompt: 'P', runId: 'k2', budgetMs: 10_000 })).state).toBe('ok')
    const [first, second] = readRuns(fake)
    expect((first!.mcpConfig as FakeMcpConfig).authorizationSha256).toBe(sha256(`Bearer ${KEY}`))
    expect((second!.mcpConfig as FakeMcpConfig).authorizationSha256).toBe(sha256(`Bearer ${OTHER_KEY}`))
    // No served identity line in hand: no identity file, no flag for one.
    expect(first!.argv).not.toContain('--append-system-prompt-file')
    expect(first!.appendedSystemPrompt).toBeNull()

    fs.rmSync(path.join(home, 'credentials'))
    const signedOut = await runner.start({ kind: 'wake', prompt: 'P', runId: 'k3', budgetMs: 10_000 })
    expect(signedOut).toMatchObject({ state: 'not_started', detail: expect.stringMatching(/no AgentChat key/) })
    expect(readRuns(fake)).toHaveLength(2)
    expect(runFilesLeft(home)).toEqual([])
  })

  it('a daemon serving another identity home: the runs’ key comes from THAT home, which every run is denied too', async () => {
    const served = path.join(sandbox, 'served-home')
    signIn(served, OTHER_KEY)
    signIn(identityHomeFor(undefined), KEY)
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, identityHome: served, env: env() })
    fs.mkdirSync(workdir, { recursive: true })
    expect(await runner.preflight()).toEqual({ ok: true })
    await runner.start({ kind: 'wake', prompt: 'P', runId: 's1', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    expect(run.argv[run.argv.indexOf('--mcp-config') + 1]).toBe(path.join(served, 'presets', 'claude-code.mcp.s1.json'))
    expect((run.mcpConfig as FakeMcpConfig).authorizationSha256).toBe(sha256(`Bearer ${OTHER_KEY}`))
    if (process.platform !== 'win32') expect(run.argv.at(-1)).toContain(`Read(/${served}/**)`)
    expect(runner.readDenyPaths()).toEqual([served, ...denyReadPathsFor(undefined), claudeProjectsDirFor(undefined)])
  })

  it('an invite run uses the invite prompt; work and full use the user-scope server (no tool config of their own)', async () => {
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'work', apiBase: API_BASE, env: env() })
    fs.mkdirSync(workdir, { recursive: true })
    await runner.start({ kind: 'invite', prompt: prompts.invite, runId: 'r2', identityLine: IDENTITY_LINE, budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    expect(run.stdin).toBe(prompts.invite)
    expect(run.argv).toEqual(claudeRunArgs('work', { denyReadPaths: [identityHomeFor(undefined), claudeUserStatePathFor(undefined)] }))
    expect(run.mcpConfig).toBeNull()
    expect(run.appendedSystemPrompt).toBeNull() // a work run loads CLAUDE.md, where the identity line is
    expect(run.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBeUndefined()
  })

  it('a relocated config dir moves the deny rules, the tool config and the key with it', async () => {
    const relocated = path.join(sandbox, 'relocated')
    signIn(path.join(relocated, 'agentchat'))
    const runner = new ClaudeRunner({ configDir: relocated, workdir, profile: 'answer', apiBase: API_BASE, env: env() })
    fs.mkdirSync(workdir, { recursive: true })
    await runner.start({ kind: 'wake', prompt: 'P', runId: 'r3', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    expect(run.argv[run.argv.indexOf('--mcp-config') + 1]).toBe(path.join(relocated, 'agentchat', 'presets', 'claude-code.mcp.r3.json'))
    expect((run.mcpConfig as FakeMcpConfig).authorizationSha256).toBe(sha256(`Bearer ${KEY}`))
    if (process.platform !== 'win32') {
      expect(run.argv.at(-1)).toContain(`Read(/${path.join(relocated, 'agentchat')}/**)`)
      expect(run.argv.at(-1)).toContain(`Read(/${path.join(relocated, '.claude.json')})`)
      expect(run.argv.at(-1)).toContain(`Read(/${path.join(relocated, 'projects')}/**)`)
    }
  })

  it('the listener stopping aborts the run: the signal reaches spawnRun and the process group is gone; the run’s files go with it', async () => {
    signIn(identityHomeFor(undefined))
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env({ FAKE_CLAUDE_RUN: 'hang' }) })
    fs.mkdirSync(workdir, { recursive: true })
    const controller = new AbortController()
    const pending = runner.start({ kind: 'wake', prompt: 'P', runId: 'r4', identityLine: IDENTITY_LINE, budgetMs: 60_000, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 400))
    controller.abort()
    const outcome = await pending
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toMatch(/interrupted/)
    expect(runFilesLeft(identityHomeFor(undefined))).toEqual([])
  }, 15_000)

  it('classifies: a failure after output is failed, a silent non-zero exit is not_started, a hang is timed_out', async () => {
    signIn(identityHomeFor(undefined))
    fs.mkdirSync(workdir, { recursive: true })
    const request = { kind: 'wake' as const, prompt: 'P', runId: 'r', budgetMs: 15_000 }
    const runner = (mode: string): ClaudeRunner => new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env({ FAKE_CLAUDE_RUN: mode }) })

    const failed = await runner('fail').start(request)
    expect(failed).toMatchObject({ state: 'failed', exitCode: 1 })
    expect(failed.detail).toContain('the fake runtime failed')

    const nostart = await runner('nostart').start(request)
    expect(nostart).toMatchObject({ state: 'not_started', exitCode: 2 })

    // README § Verify step 8: a signed-out Claude Code complains on stderr and exits — `run not_started`, complaint attached.
    const signedOut = await runner('signedout').start(request)
    expect(signedOut).toMatchObject({ state: 'not_started', exitCode: 1 })
    expect(signedOut.detail).toMatch(/nothing on stdout: Not logged in/)

    const hang = await runner('hang').start({ ...request, budgetMs: 1_500 })
    expect(hang.state).toBe('timed_out')
  }, 40_000)

  it('a missing claude binary is not_started, never a throw', async () => {
    signIn(identityHomeFor(undefined))
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, command: path.join(sandbox, 'no-such-claude'), env: env() })
    fs.mkdirSync(workdir, { recursive: true })
    expect((await runner.start({ kind: 'wake', prompt: 'P', runId: 'r', budgetMs: 1_000 })).state).toBe('not_started')
  })
})

// ─── Claude Code settings that would widen an answer run ────────────────────

describe('no answer run while a settings file grants more working directories', () => {
  it('permissions.additionalDirectories in the user’s settings: preflight and every answer run refuse, naming the file; work is not affected', async () => {
    signIn(identityHomeFor(undefined))
    const settings = path.join(fakeHome, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    fs.writeFileSync(settings, JSON.stringify({ permissions: { additionalDirectories: [path.join(sandbox, 'elsewhere')] } }))
    const answer = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env() })
    const pre = await answer.preflight()
    expect(pre.ok).toBe(false)
    expect(pre.detail).toContain(settings)
    expect(pre.detail).toContain('permissions.additionalDirectories')
    const outcome = await answer.start({ kind: 'wake', prompt: 'P', runId: 'g1', budgetMs: 10_000 })
    expect(outcome).toMatchObject({ state: 'not_started', detail: expect.stringContaining(settings) })
    expect(readRuns(fake)).toEqual([])
    expect(runFilesLeft(identityHomeFor(undefined))).toEqual([]) // refused before any key file is written

    expect(await new ClaudeRunner({ configDir: undefined, workdir, profile: 'work', apiBase: API_BASE, env: env() }).preflight()).toEqual({ ok: true })
  })

  it('a relocated config dir: its own settings.json counts, ~/.claude’s does not', async () => {
    const relocated = path.join(sandbox, 'relocated')
    fs.mkdirSync(relocated, { recursive: true })
    fs.writeFileSync(path.join(relocated, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: ['/tmp'] } }))
    const pre = await new ClaudeRunner({ configDir: relocated, workdir, profile: 'answer', apiBase: API_BASE, env: env() }).preflight()
    expect(pre).toMatchObject({ ok: false, detail: expect.stringContaining(path.join(relocated, 'settings.json')) })
  })
})

// ─── The home folder is no answer run's work folder ─────────────────────────

describe('a work folder that is the home folder', () => {
  it('answer runs work in their own empty folder beside Claude Code’s config instead; work keeps the operator’s choice', async () => {
    signIn(identityHomeFor(undefined))
    const answer = new ClaudeRunner({ configDir: undefined, workdir: fakeHome, profile: 'answer', apiBase: API_BASE, env: env() })
    const fallback = path.join(fakeHome, '.claude', 'agentchat-answer-workdir')
    expect(answer.workdir()).toBe(fallback)
    expect(await answer.preflight()).toEqual({ ok: true })
    expect(fs.statSync(fallback).isDirectory()).toBe(true)
    await answer.start({ kind: 'wake', prompt: 'P', runId: 'h1', budgetMs: 10_000 })
    expect(fs.realpathSync(readRuns(fake)[0]!.cwd)).toBe(fs.realpathSync(fallback))

    expect(new ClaudeRunner({ configDir: undefined, workdir: fakeHome, profile: 'work', apiBase: API_BASE, env: env() }).workdir()).toBe(fakeHome)
  })
})

// ─── The run's cwd is never inside a path the run is denied ─────────────────
//
// The default workdir used to be `<identity home>/daemon-workdir`: inside the
// one directory every run's file tools are denied, so a run under the default
// configuration could not read its own working directory. The invariant below
// is checked against the run's OWN argv, not against a constant.

describe('the run’s working directory is never inside a denied path', () => {
  /** The paths a run's argv denies, read back from its `Read(//p)` / `Read(//p/**)` rules. */
  const deniedByArgv = (argv: string[]): string[] => {
    const i = argv.indexOf('--disallowedTools')
    if (i === -1) return []
    return (argv[i + 1] ?? '')
      .split(',')
      .map((rule) => rule.match(/^Read\(\/(\/.*?)(?:\/\*\*)?\)$/)?.[1])
      .filter((p): p is string => p !== undefined)
  }

  it('the default workdir sits BESIDE the identity home, follows the config dir, and is not the old in-home default', () => {
    for (const configDir of [undefined, path.join(sandbox, 'relocated')]) {
      const workdir = runWorkdirFor(configDir)
      expect(path.dirname(workdir)).toBe(path.dirname(identityHomeFor(configDir)))
      expect(deniedAncestorOf(workdir, denyReadPathsFor(configDir))).toBeNull()
      expect(workdir).not.toBe(legacyRunWorkdirFor(configDir))
      // The bug, as it was: the old default is inside the identity home.
      expect(deniedAncestorOf(legacyRunWorkdirFor(configDir), denyReadPathsFor(configDir))).toBe(identityHomeFor(configDir))
    }
    expect(runWorkdirFor(path.join(sandbox, 'cfg'))).toBe(path.join(sandbox, 'cfg', 'agentchat-workdir'))
    // AGENTCHAT_RUN_CWD outranks the default; blank is unset.
    expect(resolveRunWorkdir(undefined, {})).toBe(runWorkdirFor(undefined))
    expect(resolveRunWorkdir(undefined, { AGENTCHAT_RUN_CWD: '  ' })).toBe(runWorkdirFor(undefined))
    expect(resolveRunWorkdir(undefined, { AGENTCHAT_RUN_CWD: path.join(sandbox, 'ws') })).toBe(path.join(sandbox, 'ws'))
  })

  it('containment is by whole path segment: a sibling sharing the prefix is outside; a trailing separator changes nothing', () => {
    const home = path.join(sandbox, '.claude', 'agentchat')
    expect(deniedAncestorOf(path.join(sandbox, '.claude', 'agentchat-workdir'), [home])).toBeNull()
    expect(deniedAncestorOf(path.join(sandbox, '.claude'), [home])).toBeNull()
    expect(deniedAncestorOf(home, [home])).toBe(home)
    expect(deniedAncestorOf(path.join(home, 'daemon-workdir'), [home])).toBe(home)
    expect(deniedAncestorOf(path.join(home, 'daemon-workdir') + path.sep, [home + path.sep])).toBe(home)
    expect(deniedAncestorOf(path.join(sandbox, '.claude.json'), denyReadPathsFor(sandbox))).toBe(path.join(sandbox, '.claude.json'))
  })

  it('INVARIANT: the cwd a run is spawned in is covered by none of the Read deny rules on its own argv', async () => {
    const configDir = path.join(sandbox, 'cfg')
    const workdir = runWorkdirFor(configDir) // the daemon's default for this config
    const runner = new ClaudeRunner({ configDir, workdir, profile: 'work', apiBase: API_BASE, env: env() })
    expect(runner.workdirDeniedBy()).toBeNull()
    expect(await runner.preflight()).toEqual({ ok: true })
    await runner.start({ kind: 'wake', prompt: 'P', runId: 'r-inv', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    const denied = deniedByArgv(run.argv)
    if (process.platform !== 'win32') {
      // The parser reads back exactly what the runner denies, and the key store IS covered.
      expect([...new Set(denied)]).toEqual(denyReadPathsFor(configDir)) // one path, two rules (dir and dir/**)
      expect(deniedAncestorOf(path.join(identityHomeFor(configDir), 'credentials'), denied)).toBe(identityHomeFor(configDir))
      expect(deniedAncestorOf(path.join(configDir, '.claude.json'), denied)).toBe(path.join(configDir, '.claude.json'))
    }
    expect(deniedAncestorOf(run.cwd, denied)).toBeNull()
    expect(deniedAncestorOf(run.cwd, denyReadPathsFor(configDir))).toBeNull()
  })

  it('INVARIANT, answer: the cwd is not denied, and the run’s own tool config (it holds the key) is', async () => {
    const configDir = path.join(sandbox, 'cfg')
    signIn(identityHomeFor(configDir))
    const runner = new ClaudeRunner({ configDir, workdir: runWorkdirFor(configDir), profile: 'answer', apiBase: API_BASE, env: env() })
    expect(await runner.preflight()).toEqual({ ok: true })
    await runner.start({ kind: 'wake', prompt: 'P', runId: 'r-ans', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    const denied = deniedByArgv(run.argv)
    expect(deniedAncestorOf(run.cwd, denied)).toBeNull()
    if (process.platform !== 'win32') {
      expect(deniedAncestorOf(run.argv[run.argv.indexOf('--mcp-config') + 1]!, denied)).toBe(identityHomeFor(configDir))
      expect(deniedAncestorOf(path.join(configDir, 'projects', 'p', 'memory', 'MEMORY.md'), denied)).toBe(path.join(configDir, 'projects'))
    }
  })

  it('the old default fails that invariant; a configured workdir inside the key store is said once, with the fix, and still runs', async () => {
    const configDir = path.join(sandbox, 'cfg')
    signIn(identityHomeFor(configDir))
    const workdir = legacyRunWorkdirFor(configDir)
    const runner = new ClaudeRunner({ configDir, workdir, profile: 'answer', apiBase: API_BASE, env: env() })
    expect(runner.workdirDeniedBy()).toBe(identityHomeFor(configDir))

    const lines: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
    const level = process.env['AGENTCHAT_LOG_LEVEL']
    process.env['AGENTCHAT_LOG_LEVEL'] = 'warn'
    try {
      expect(await runner.preflight()).toEqual({ ok: true })
      expect(await runner.preflight()).toEqual({ ok: true }) // preflight repeats; the warning does not
    } finally {
      write.mockRestore()
      if (level === undefined) delete process.env['AGENTCHAT_LOG_LEVEL']
      else process.env['AGENTCHAT_LOG_LEVEL'] = level
    }
    const warnings = lines.filter((line) => line.includes('cannot read their own working directory'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(workdir)
    expect(warnings[0]).toContain(runWorkdirFor(configDir))
    expect(warnings[0]).toContain('daemon install')

    await runner.start({ kind: 'wake', prompt: 'P', runId: 'r-legacy', budgetMs: 10_000 })
    const run = readRuns(fake)[0]!
    if (process.platform !== 'win32') expect(deniedAncestorOf(run.cwd, deniedByArgv(run.argv))).toBe(identityHomeFor(configDir))
  })

  it('preflight creates the workdir owner-only, as the identity home is created', async () => {
    const runner = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env() })
    expect(await runner.preflight()).toEqual({ ok: true })
    if (process.platform !== 'win32') expect(fs.statSync(workdir).mode & 0o777).toBe(0o700)
  })
})

describe('which MCP servers a run loads', () => {
  // `work` and `full` runs use the user-scope `agentchat` server the installer
  // registered, beside every other MCP server the user has, as any session
  // does. An `answer` run — started by any peer's message — loads the hosted
  // AgentChat server ALONE, from a tool config of its own (`--strict-mcp-config`).
  it('work and full pass no --mcp-config; answer passes its own tool config, strict', () => {
    for (const profile of ['work', 'full'] as const) {
      const args = new ClaudeRunner({ configDir: undefined, workdir, profile, apiBase: API_BASE, env: env() }).args()
      expect(args).not.toContain('--mcp-config')
      expect(args).not.toContain('--strict-mcp-config')
    }
    const answer = new ClaudeRunner({ configDir: undefined, workdir, profile: 'answer', apiBase: API_BASE, env: env() }).args('run-7')
    expect(answer.slice(answer.indexOf('--mcp-config'), answer.indexOf('--mcp-config') + 3)).toEqual([
      '--mcp-config',
      path.join(identityHomeFor(undefined), 'presets', 'claude-code.mcp.run-7.json'),
      '--strict-mcp-config',
    ])
  })
})

describe('what an interrupted answer run leaves behind', () => {
  it('removeAnswerRunFiles takes its tool configs, identity lines and half-written temp files, nothing else', () => {
    const home = path.join(sandbox, 'id-home')
    const dir = path.join(home, 'presets')
    fs.mkdirSync(dir, { recursive: true })
    const left = ['claude-code.mcp.r1.json', 'claude-code.mcp.r1.identity.md', 'claude-code.mcp.run.json', '.claude-code.mcp.r2.json.0123456789ab.tmp', '.claude-code.mcp.r2.identity.md.ba9876543210.tmp']
    const kept = ['claude-code.mcp.json', 'notes.txt', 'claude-code.mcp.r1.json.bak', 'codex.mcp.r1.json']
    for (const name of [...left, ...kept]) fs.writeFileSync(path.join(dir, name), 'x')
    const { removed, failed } = removeAnswerRunFiles(home)
    expect(removed.sort()).toEqual([...left].sort())
    expect(failed).toEqual([])
    expect(fs.readdirSync(dir).sort()).toEqual([...kept].sort())
  })

  it('the presets folder goes when nothing else is in it; no folder is no error', () => {
    const home = path.join(sandbox, 'id-home')
    expect(removeAnswerRunFiles(home)).toEqual({ removed: [], failed: [] })
    fs.mkdirSync(path.join(home, 'presets'), { recursive: true })
    fs.writeFileSync(path.join(home, 'presets', 'claude-code.mcp.r9.json'), '{}')
    expect(removeAnswerRunFiles(home).removed).toEqual(['claude-code.mcp.r9.json'])
    expect(fs.existsSync(path.join(home, 'presets'))).toBe(false)
    expect(fs.existsSync(home)).toBe(true)
  })
})

describe('the prompt’s last line and the profile words', () => {
  it('an answer run’s prompt carries no pointer to a skill it cannot open; work and full get it', () => {
    const skill = path.join(fakeHome, '.claude', 'skills', 'agentchat', 'SKILL.md')
    expect(runPointer('answer', skill)).toBe('')
    for (const profile of ['work', 'full'] as const) expect(runPointer(profile, skill)).toBe(manualPointer(`at ${skill}`))
  })

  it('work and full are named with the engine’s warning; answer with nothing', () => {
    expect(profileNote('answer')).toBe('')
    expect(profileNote('work')).toBe(` — ${PEER_RUN_WARNING}`)
    expect(profileNote('full')).toBe(` — ${PEER_RUN_WARNING}`)
  })
})
