import * as fs from 'node:fs'
import * as path from 'node:path'

export interface FakeClaude {
  binDir: string
  /** `~/.claude.json` for a sandbox HOME, or `$CLAUDE_CONFIG_DIR/.claude.json`. */
  defaultUserState: string
  relocatedUserState: string
  /** JSON lines, one per `claude -p` run: argv, stdin, cwd, selected env. */
  recordPath: string
}

/**
 * A deterministic `claude` for tests. Models exactly the surfaces the integration
 * uses — `--version`, `auth status`, `mcp add|remove|get` at user scope, and
 * `-p` headless runs — so nothing here reaches a developer's real Claude Code.
 *
 * Env knobs read by the fake at run time:
 *   FAKE_CLAUDE_LOGGED_OUT=1   `auth status` exits 1
 *   FAKE_CLAUDE_AUTH=hang      `auth status` never answers (the probe kills it)
 *   FAKE_CLAUDE_RUN=ok|fail|nostart|signedout|hang   how a `-p` run ends (default ok)
 *   FAKE_CLAUDE_RECORD=<file>  where `-p` runs append their record
 *
 * A run's record also says what its `--mcp-config` file held when the run
 * started (server names, URL, header names, the file mode, and the
 * Authorization header as a SHA-256 — never the key itself) and the text of its
 * `--append-system-prompt-file`: both are written for one run and removed after it.
 */
export function installFakeClaude(root: string, version = '2.1.316'): FakeClaude {
  const binDir = path.join(root, 'fake-bin')
  const recordPath = path.join(root, 'fake-claude-runs.jsonl')
  fs.mkdirSync(binDir, { recursive: true })
  const script = path.join(binDir, 'claude')
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const configured = (process.env.CLAUDE_CONFIG_DIR || '').trim()",
      "const home = process.env.HOME || process.env.USERPROFILE || ''",
      "const statePath = configured ? path.join(configured, '.claude.json') : path.join(home, '.claude.json')",
      'const args = process.argv.slice(2)',
      'const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")) } catch { return {} } }',
      'const writeState = (doc) => { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(doc, null, 2)) }',
      `if (args[0] === '--version') { console.log(${JSON.stringify(`${version} (Claude Code)`)}); process.exit(0) }`,
      "if (args[0] === 'auth' && args[1] === 'status' && process.env.FAKE_CLAUDE_AUTH === 'hang') { setInterval(() => {}, 1000); return }",
      "if (args[0] === 'auth' && args[1] === 'status') { if (process.env.FAKE_CLAUDE_LOGGED_OUT === '1') { console.log('{\"loggedIn\":false}'); process.exit(1) } console.log('{\"loggedIn\":true}'); process.exit(0) }",
      "if (args[0] === 'mcp' && args[1] === 'add') {",
      '  const rest = args.slice(2); const flags = {}; const positionals = []; const headers = {}',
      '  for (let i = 0; i < rest.length; i++) {',
      "    if (rest[i] === '--transport' || rest[i] === '-t') flags.transport = rest[++i]",
      "    else if (rest[i] === '--scope' || rest[i] === '-s') flags.scope = rest[++i]",
      "    else if (rest[i] === '--header' || rest[i] === '-H') { const h = rest[++i]; const idx = h.indexOf(':'); headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim() }",
      "    else if (rest[i] === '--') { positionals.push(...rest.slice(i + 1)); break }",
      '    else positionals.push(rest[i])',
      '  }',
      "  if (flags.scope !== 'user') { console.error('fake claude: the integration must register at user scope'); process.exit(2) }",
      '  const [name, target] = positionals',
      '  const doc = readState()',
      "  if (doc.mcpServers && doc.mcpServers[name]) { console.error('MCP server \"' + name + '\" already exists in user config'); process.exit(1) }",
      "  if (flags.transport === 'http') doc.mcpServers = { ...(doc.mcpServers || {}), [name]: { type: 'http', url: target, headers } }",
      "  else doc.mcpServers = { ...(doc.mcpServers || {}), [name]: { type: 'stdio', command: target, args: positionals.slice(2), env: {} } }",
      '  writeState(doc)',
      "  console.log('Added ' + flags.transport + ' MCP server ' + name + ' to user config')",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'mcp' && args[1] === 'remove') {",
      "  const name = args.filter((a, i) => !a.startsWith('-') && !(args[i - 1] === '--scope' || args[i - 1] === '-s')).slice(2)[0]",
      '  const doc = readState()',
      "  if (!doc.mcpServers || !doc.mcpServers[name]) { console.error('No MCP server found with name: ' + name); process.exit(1) }",
      '  delete doc.mcpServers[name]; writeState(doc)',
      "  console.log('Removed MCP server ' + name + ' from user config')",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'mcp' && args[1] === 'get') {",
      '  const doc = readState(); const entry = doc.mcpServers && doc.mcpServers[args[2]]',
      "  if (!entry) { console.error('No MCP server found with name: ' + args[2]); process.exit(1) }",
      '  console.log(JSON.stringify(entry)); process.exit(0)',
      '}',
      "if (args[0] === '-p') {",
      "  let stdin = ''",
      "  process.stdin.setEncoding('utf8')",
      "  process.stdin.on('data', (c) => { stdin += c })",
      "  process.stdin.on('end', () => {",
      "    const at = args.indexOf('--mcp-config')",
      '    let mcpConfig = null',
      "    if (at >= 0) { try { const file = args[at + 1]; const servers = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {}; const entry = servers.agentchat || {}; const headers = entry.headers || {}; mcpConfig = { servers: Object.keys(servers), type: entry.type, url: entry.url, headerNames: Object.keys(headers), authorizationSha256: headers.Authorization === undefined ? null : require('node:crypto').createHash('sha256').update(headers.Authorization).digest('hex'), client: headers['X-AgentChat-Client'], clientVersion: headers['X-AgentChat-Client-Version'], mode: fs.statSync(file).mode & 0o777 } } catch { mcpConfig = 'unreadable' } }",
      "    const sp = args.indexOf('--append-system-prompt-file')",
      '    let appendedSystemPrompt = null',
      "    if (sp >= 0) { try { appendedSystemPrompt = fs.readFileSync(args[sp + 1], 'utf8') } catch { appendedSystemPrompt = 'unreadable' } }",
      "    const record = { argv: args, stdin, cwd: process.cwd(), mcpConfig, appendedSystemPrompt, env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_MCP_STARTUP_WAIT_MS: process.env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS, DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER, CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_DISABLE_CLAUDE_MDS: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, AGENTCHAT_API_KEY: process.env.AGENTCHAT_API_KEY } }",
      "    if (process.env.FAKE_CLAUDE_RECORD) fs.appendFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify(record) + '\\n')",
      "    const mode = process.env.FAKE_CLAUDE_RUN || 'ok'",
      "    if (mode === 'nostart') process.exit(2)",
      // A run that got going (something on stdout) and then failed. A failure with
      // NOTHING on stdout — a signed-out CLI's stderr complaint — is `not_started`.
      "    if (mode === 'fail') { process.stdout.write('started\\n'); process.stderr.write('error: the fake runtime failed\\n'); process.exit(1) }",
      "    if (mode === 'signedout') { process.stderr.write('Not logged in · Please run /login\\n'); process.exit(1) }",
      "    if (mode === 'hang') { process.stdout.write('started\\n'); setInterval(() => {}, 1000); return }",
      "    process.stdout.write('Peer text echoed by the model — must be discarded\\n'); process.exit(0)",
      '  })',
      '  return',
      '}',
      "console.error('unsupported fake claude command: ' + args.join(' '))",
      'process.exit(2)',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  // Windows resolves bare commands through PATHEXT rather than shebangs.
  fs.writeFileSync(path.join(binDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude" %*\r\n')

  return {
    binDir,
    defaultUserState: path.join(root, '.claude.json'),
    relocatedUserState: path.join(root, '.claude', '.claude.json'),
    recordPath,
  }
}

/** What a run's `--mcp-config` held when it started (`'unreadable'` when it could not be read). */
export interface FakeMcpConfig {
  servers: string[]
  type?: string
  url?: string
  headerNames: string[]
  /** SHA-256 hex of the Authorization header's value; null without one. */
  authorizationSha256: string | null
  client?: string
  clientVersion?: string
  mode: number
}

export interface FakeClaudeRun {
  argv: string[]
  stdin: string
  cwd: string
  env: Record<string, string | undefined>
  /** Null without `--mcp-config`. */
  mcpConfig: FakeMcpConfig | 'unreadable' | null
  /** The text of the run's `--append-system-prompt-file`; null without one. */
  appendedSystemPrompt: string | null
}

export function readRuns(fake: FakeClaude): FakeClaudeRun[] {
  if (!fs.existsSync(fake.recordPath)) return []
  return fs
    .readFileSync(fake.recordPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeClaudeRun)
}
