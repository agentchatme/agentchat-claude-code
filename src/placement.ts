import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  atomicWriteFile,
  checkManual,
  clientHeadersOf,
  describeManualSync,
  hostedMcpUrl,
  log,
  offerDeclined,
  readAnchorHandleAt,
  anchorIsCurrentAt,
  removeAnchorAt,
  renderAnchorBlock,
  renderDeclinedBlock,
  renderUnregisteredBlock,
  spawnCommandSync,
  syncManual,
  writeAnchor,
  type ManualSyncResult,
  type ServedManual,
} from '@agentchatme/agent-core'
import {
  CLIENT,
  MCP_SERVER_NAME,
  anchorFile,
  claudeHome,
  claudeUserStatePath,
  hostCopy,
  identityHome,
  settingsPath,
  skillDir,
  skillPath,
} from './host.js'
import { answerToolConfigFor, removeAnswerRunFiles } from './runner.js'

// ─── Placement: the four texts, where Claude Code loads them ────────────────
//
// 1. **The identity line** — the shared AgentChat identity block in
//    `~/.claude/CLAUDE.md` (Claude Code's always-loaded user instructions):
//    the fences, a handle line (`<!-- agentchat:handle <handle> -->`) and the
//    served identity line, in the shape every AgentChat integration writes
//    (the SDK kit's `integration.anchor`, through agent-core). It is replaced
//    where it stands, never moved, and the file is written atomically, so the
//    user's own text around it is kept and the file is never half-written.
// 2. **The manual** — the served one (the address and version `GET /v1/texts`
//    announce; https://agentchat.me/skill.md today) as the personal skill
//    `~/.claude/skills/agentchat/SKILL.md` (code.claude.com/docs/en/skills.md:
//    personal skills live at `~/.claude/skills/<skill-name>/SKILL.md`, loaded on
//    demand by description). agent-core's `syncManual` downloads it when the
//    file's version is not the announced one and keeps the file on any failure;
//    the daemon keeps it current from then on. The copy bundled in agent-core
//    is written only when there is no file and nothing verified can be had.
// 3. **The hosted tool server** — the user-scope MCP server `agentchat`,
//    transport HTTP, `https://api.agentchat.me/mcp`, registered through Claude
//    Code's own CLI: `claude mcp add-json --scope user agentchat '<json>'`
//    (code.claude.com/docs/en/mcp.md, "Add MCP servers from JSON
//    configuration"). The entry carries the client headers and a
//    `headersHelper`, never the key: Claude Code runs the helper "fresh on each
//    connection, at session start and on reconnect" and again after a 401/403,
//    and sends the JSON object it prints as headers (same page, "Use dynamic
//    headers for custom authentication"; a user-scope helper needs no folder
//    trust and runs in the configuration directory). Ours is a fixed script,
//    `<identity home>/bin/mcp-headers.mjs`, that prints
//    `{"Authorization":"Bearer <key>"}` from the `credentials` file beside it
//    and reads no environment variable. So the key is on no command line (the
//    JSON on `add-json`'s argv holds two paths) and in no file but
//    `credentials`: not in `~/.claude.json`, not in the copies of it Claude
//    Code keeps in `~/.claude/backups`, not in `claude mcp get`'s output. A new
//    key (login, recover, rotate) is the helper's next answer, with no
//    re-registration. Releases up to 0.5.2 put the key in a static
//    `Authorization` header with `claude mcp add --header`, which showed it in
//    `ps` to every user of the machine while `claude` ran; install, login,
//    recover and `doctor --fix` replace such an entry.
//    Not `add-json -` (JSON on stdin): Claude Code refuses stdin inside a
//    Claude Code session, which is where the agent itself runs sign-up.
// 4. **The key** — in the identity home's `credentials` (0600), and nowhere
//    the registration above writes.
//
// Legacy cleanup on upgrade: the four lifecycle hooks the hook-based releases wrote
// into `settings.json`, the stdio `mcp-proxy` MCP entry, the stable CLI bundle
// under the identity home, and the old on-disk manual at `<home>/SKILL.md`.
// Receiving no longer needs hooks.

/**
 * `warned`: done as far as it can be and nothing broken, but not current — a
 * manual left at its version (or the bundled copy) because the announced one
 * could not be downloaded. Printed as a warning; never fails an install.
 */
export type PlacementStatus = 'ok' | 'changed' | 'warned' | 'skipped' | 'failed'

export interface PlacementStep {
  readonly name: 'identity' | 'manual' | 'mcp' | 'legacy' | 'runs'
  readonly status: PlacementStatus
  readonly detail: string
}

export interface PlacementIdentity {
  readonly handle: string
  readonly apiKey: string
  readonly apiBase: string
  /** The served identity line for this agent (`GET /v1/texts`, or the identity-home cache); null when neither could be had. */
  readonly identityLine: string | null
  /**
   * The served `identity_line_template` from the same texts; null when none
   * are in hand. Only checking needs it: it is how a block without a handle
   * line, in the words the server serves today, is read back as this agent's
   * (an older release's block, which then reads as needing a refresh rather
   * than as missing). Writing finds the block by its fences and needs no
   * template.
   */
  readonly identityLineTemplate: string | null
}

const LEGACY_BUNDLE = path.join('bin', 'agentchat.mjs')
const LEGACY_MANUAL = 'SKILL.md'

// ─── Claude's own CLI, invoked the way the user would ───────────────────────

function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const configured = process.env['CLAUDE_CONFIG_DIR']?.trim()
  if (configured !== undefined && configured.length > 0) env['CLAUDE_CONFIG_DIR'] = path.resolve(configured)
  else delete env['CLAUDE_CONFIG_DIR'] // unset is not `~/.claude`: it changes where ~/.claude.json lives
  // Commonly run from Claude's own Bash tool; the nested-session sentinel can
  // make the CLI reject child invocations wholesale.
  delete env['CLAUDECODE']
  return env
}

function claudeCwd(): string {
  for (const candidate of [identityHome(), claudeHome()]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return process.cwd()
}

function runClaude(args: string[], timeout = 20_000): { ok: boolean; detail: string } {
  const result = spawnCommandSync('claude', args, { encoding: 'utf-8', timeout, windowsHide: true, env: claudeEnv(), cwd: claudeCwd() })
  if (result.error) return { ok: false, detail: result.error.message }
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
  return { ok: result.status === 0, detail: output || `exited ${result.status}` }
}

// ─── The headers helper: the key, read from `credentials` on each connection ─

/** Where the helper lives: the identity home's `bin/`, beside the durable daemon bundle. */
export function headersHelperPath(): string {
  return path.join(identityHome(), 'bin', 'mcp-headers.mjs')
}

/**
 * The helper, byte for byte. Claude Code sends what it prints as headers. It
 * reads the `credentials` file of the home it sits in and nothing else (no
 * environment variable: the identity is the home's), prints
 * `{"Authorization":"Bearer <key>"}`, or `{}` when there is no key (the hosted
 * tools then show the sign-up tools), and never fails a connection.
 */
export const HEADERS_HELPER_SOURCE = [
  '// Written by @agentchatme/claude-code. Claude Code runs this on each connection to the',
  '// user MCP server "agentchat" (its headersHelper) and sends what it prints as headers:',
  '// the Authorization header for the key in the credentials file of this identity home,',
  '// or nothing when there is none. It reads no environment variable. Do not edit: install',
  '// and doctor --fix rewrite it.',
  "import { readFileSync } from 'node:fs'",
  'let headers = {}',
  'try {',
  "  const creds = JSON.parse(readFileSync(new URL('../credentials', import.meta.url), 'utf8'))",
  "  const key = creds !== null && typeof creds.api_key === 'string' ? creds.api_key.trim() : ''",
  '  if (key.length >= 20 && !/\\s/.test(key)) headers = { Authorization: `Bearer ${key}` }',
  '} catch {}',
  'process.stdout.write(JSON.stringify(headers))',
  '',
].join('\n')

/**
 * The `headersHelper` command: this Node and the helper, each quoted for the
 * shell Claude Code runs it in — single quotes on POSIX (a `'` inside written
 * as `'\\''`), double quotes on Windows. Null when a path holds what that
 * quoting cannot carry (`"`, `%`, `$` or a backtick on Windows) or a line
 * break anywhere. The Codex integration writes the same command for its
 * `http_headers_helper`.
 */
export function headersHelperCommand(node: string = process.execPath, script: string = headersHelperPath(), platform: NodeJS.Platform = process.platform): string | null {
  const paths = [node, script]
  if (paths.some((p) => /[\r\n]/.test(p))) return null
  if (platform === 'win32') return paths.some((p) => /["%$`]/.test(p)) ? null : paths.map((p) => `"${p}"`).join(' ')
  return paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ')
}

const POSIX_TOKEN = "'((?:[^'\\r\\n]|'\\\\'')*)'"

/** The Node and the script a `headersHelper` command of ours names; null for any other command. */
export function parseHeadersHelper(command: unknown): { node: string; script: string } | null {
  if (typeof command !== 'string') return null
  const posix = new RegExp(`^${POSIX_TOKEN} ${POSIX_TOKEN}$`).exec(command)
  if (posix !== null) return { node: posix[1]!.replace(/'\\''/g, "'"), script: posix[2]!.replace(/'\\''/g, "'") }
  const win = /^"([^"\r\n]+)" "([^"\r\n]+)"$/.exec(command)
  return win === null ? null : { node: win[1]!, script: win[2]! }
}

function helperSourceCurrent(): boolean {
  try {
    return fs.readFileSync(headersHelperPath(), 'utf-8') === HEADERS_HELPER_SOURCE
  } catch {
    return false
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Write the helper when it is missing or not this release's. Owner-only: it sits in the identity home. */
export function writeHeadersHelper(): void {
  if (helperSourceCurrent()) return
  atomicWriteFile(headersHelperPath(), HEADERS_HELPER_SOURCE, 0o600)
}

/**
 * Whether the entry's `headersHelper` is ours and works as written:
 * `current` (our script, this release's text, a Node that is there),
 * `stale` (ours, but the script or the Node is not), `missing` (none, or
 * someone else's command).
 */
export type HeadersHelperState = 'current' | 'stale' | 'missing'

function headersHelperStateOf(command: unknown): HeadersHelperState {
  const parsed = parseHeadersHelper(command)
  if (parsed === null || path.resolve(parsed.script) !== path.resolve(headersHelperPath())) return 'missing'
  return helperSourceCurrent() && isExecutable(parsed.node) ? 'current' : 'stale'
}

/**
 * Run the entry's helper the way Claude Code does (its Node, its script) and
 * say whether it yields this agent's key. Null when it does; else why not, in
 * words that never contain a key.
 */
export function headersHelperProblem(command: unknown, apiKey: string): string | null {
  const parsed = parseHeadersHelper(command)
  if (parsed === null) return 'the entry has no headers helper of this integration'
  const result = spawnCommandSync(parsed.node, [parsed.script], { encoding: 'utf-8', timeout: 10_000, windowsHide: true, cwd: claudeHome() })
  if (result.error) return `its helper could not run (${result.error.message})`
  if (result.status !== 0) return `its helper exited ${result.status}`
  let headers: unknown
  try {
    headers = JSON.parse(String(result.stdout ?? ''))
  } catch {
    return 'its helper printed something other than a JSON object'
  }
  const auth = headers !== null && typeof headers === 'object' ? (headers as Record<string, unknown>)['Authorization'] : undefined
  if (auth === undefined) return `its helper finds no key in ${path.join(identityHome(), 'credentials')}`
  return auth === `Bearer ${apiKey}` ? null : "its helper yields a key other than this agent's credentials"
}

// ─── The hosted MCP entry ───────────────────────────────────────────────────

/**
 * Whether the entry names this runtime to the hosted tools: `current` (this
 * package's name and version), `stale` (the name, another version),
 * `missing`. The hosted tool server names a client only from
 * `X-AgentChat-Client` (never from the MCP handshake); without it this agent
 * is an unknown client, shown the wake-webhook tools — a second way of being
 * woken the listener makes unnecessary — and the tool names unspelled.
 */
export type ClientHeadersState = 'current' | 'stale' | 'missing'

export type McpEntryState =
  | { state: 'missing' }
  | {
      state: 'ours'
      url: string
      /** The entry's static `Authorization` header is this identity's key (how releases up to 0.5.2 placed it). */
      currentKey: boolean
      /** Any static `Authorization` header: a key written into `~/.claude.json`, which this release takes out. */
      staticKey: boolean
      helper: HeadersHelperState
      clientHeaders: ClientHeadersState
    }
  | { state: 'legacy' }
  | { state: 'foreign'; detail: string; clientHeaders: ClientHeadersState }
  | { state: 'unavailable'; detail: string }

/** The client identity the entry sends with every request: agent-core's `clientHeadersOf` (the names the server reads). */
export function clientHeaders(): Record<string, string> {
  return clientHeadersOf(CLIENT)
}

function clientHeadersStateOf(headers: unknown): ClientHeadersState {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return 'missing'
  // HTTP header names are case-insensitive: an entry written by hand may spell them either way.
  const sent = new Map(Object.entries(headers as Record<string, unknown>).map(([name, value]) => [name.toLowerCase(), value]))
  const expected = Object.entries(clientHeaders())
  const [nameHeader, versionHeader] = [expected[0]!, expected[1]!]
  if (sent.get(nameHeader[0].toLowerCase()) !== nameHeader[1]) return 'missing'
  return sent.get(versionHeader[0].toLowerCase()) === versionHeader[1] ? 'current' : 'stale'
}

function readUserState(): Record<string, unknown> | null {
  const raw = fs.readFileSync(claudeUserStatePath(), 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
  return parsed as Record<string, unknown>
}

/** One field of the user-scope `agentchat` entry as it is on disk, or undefined. */
function readEntryField(field: string): unknown {
  try {
    const servers = readUserState()?.['mcpServers']
    const entry = servers !== null && typeof servers === 'object' ? (servers as Record<string, unknown>)[MCP_SERVER_NAME] : undefined
    return entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>)[field] : undefined
  } catch {
    return undefined
  }
}

function isLegacyStdioEntry(entry: Record<string, unknown>): boolean {
  const args = Array.isArray(entry['args']) ? entry['args'] : []
  return (
    (entry['type'] === undefined || entry['type'] === 'stdio') &&
    entry['command'] === 'node' &&
    args.length === 2 &&
    typeof args[0] === 'string' &&
    args[0].replace(/\\/g, '/').endsWith('/agentchat/bin/agentchat.mjs') &&
    args[1] === 'mcp-proxy'
  )
}

/**
 * Classify the user-scope `agentchat` server. Ours when it is an HTTP entry at
 * this identity's hosted MCP URL, OR one whose `headersHelper` is this
 * integration's script, OR one carrying this identity's key in a static
 * `Authorization` header (how releases up to 0.5.2 placed it) — the helper and
 * the key are the stronger evidence, and they are what keep a non-default
 * `api_base` registration from being left behind as "foreign" on logout.
 * `apiKey` decides `currentKey`.
 */
export function inspectHostedMcp(apiKey: string | null, apiBase: string): McpEntryState {
  let state: Record<string, unknown> | null
  try {
    state = readUserState()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'missing' }
    return { state: 'unavailable', detail: `could not read ${claudeUserStatePath()}: ${String(err)}` }
  }
  const servers = state?.['mcpServers']
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return { state: 'missing' }
  const entry = (servers as Record<string, unknown>)[MCP_SERVER_NAME]
  if (entry === undefined || entry === null) return { state: 'missing' }
  if (typeof entry !== 'object' || Array.isArray(entry)) return { state: 'foreign', detail: 'the user-scope server named "agentchat" is not an object', clientHeaders: 'missing' }
  const record = entry as Record<string, unknown>
  if (isLegacyStdioEntry(record)) return { state: 'legacy' }
  const type = record['type']
  const url = record['url']
  const headers = record['headers']
  // Header names are case-insensitive: an entry written by hand may spell it either way.
  const auth =
    headers && typeof headers === 'object' && !Array.isArray(headers)
      ? Object.entries(headers as Record<string, unknown>).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
      : undefined
  const currentKey = apiKey !== null && typeof auth === 'string' && auth === `Bearer ${apiKey}`
  const isHttp = type === 'http' || type === 'streamable-http'
  const named = clientHeadersStateOf(headers)
  const helper = headersHelperStateOf(record['headersHelper'])
  if (isHttp && typeof url === 'string' && (url === hostedMcpUrl(apiBase) || currentKey || helper !== 'missing')) {
    return { state: 'ours', url, currentKey, staticKey: auth !== undefined, helper, clientHeaders: named }
  }
  return { state: 'foreign', detail: `the user-scope server named "agentchat" points at ${typeof url === 'string' ? url : 'a different command'} and is not this integration's`, clientHeaders: named }
}

function tightenUserStateMode(): void {
  // The key is no longer in this file, but other servers' secrets may be.
  // Claude Code may rewrite it with its own mode later.
  try {
    fs.chmodSync(claudeUserStatePath(), 0o600)
  } catch {
    /* absent or not ours to chmod */
  }
}

/**
 * Register the hosted MCP server at user scope: the URL, the client headers,
 * and the helper that reads the key from `credentials` — never the key. An
 * entry an earlier release wrote with the key in it is replaced, which takes
 * the key out of `~/.claude.json`.
 */
export function placeHostedMcp(identity: PlacementIdentity): PlacementStep {
  const current = inspectHostedMcp(identity.apiKey, identity.apiBase)
  if (current.state === 'unavailable') return { name: 'mcp', status: 'failed', detail: current.detail }
  if (current.state === 'foreign') {
    return { name: 'mcp', status: 'skipped', detail: `${current.detail} — left untouched; rename or remove it, then re-run` }
  }
  try {
    writeHeadersHelper()
  } catch (err) {
    return { name: 'mcp', status: 'failed', detail: `could not write the headers helper ${headersHelperPath()}: ${String(err)}` }
  }
  const keyNote = `the key stays in ${path.join(identityHome(), 'credentials')}; Claude Code asks ${headersHelperPath()} for it on each connection`
  if (current.state === 'ours' && !current.staticKey && current.helper === 'current' && current.clientHeaders === 'current') {
    tightenUserStateMode()
    return { name: 'mcp', status: 'ok', detail: `hosted tools registered as user MCP "${MCP_SERVER_NAME}" → ${current.url} (${keyNote})` }
  }
  const command = headersHelperCommand()
  if (command === null) {
    return { name: 'mcp', status: 'failed', detail: `the path of Node (${process.execPath}) or of ${headersHelperPath()} holds a character a shell command cannot carry quoted; move it, then re-run` }
  }
  // Before the old entry goes: the helper, run as Claude Code runs it, yields this agent's key.
  const problem = headersHelperProblem(command, identity.apiKey)
  if (problem !== null) return { name: 'mcp', status: 'failed', detail: `the user MCP "${MCP_SERVER_NAME}" was left as it was: ${problem}` }
  if (current.state === 'ours' || current.state === 'legacy') {
    const removed = runClaude(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME])
    if (!removed.ok) return { name: 'mcp', status: 'failed', detail: `could not replace the existing "${MCP_SERVER_NAME}" MCP entry: ${removed.detail}` }
  }
  const url = hostedMcpUrl(identity.apiBase)
  // No key in this JSON: it is on `claude`'s command line, where `ps` shows it.
  const entry = { type: 'http', url, headers: clientHeaders(), headersHelper: command }
  const added = runClaude(['mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(entry)])
  if (!added.ok) return { name: 'mcp', status: 'failed', detail: `claude mcp add-json failed: ${added.detail}` }
  const after = inspectHostedMcp(identity.apiKey, identity.apiBase)
  if (after.state !== 'ours' || after.staticKey || after.helper !== 'current' || after.clientHeaders !== 'current') {
    return { name: 'mcp', status: 'failed', detail: `claude mcp add-json reported success but ${claudeUserStatePath()} does not carry the entry with the headers helper and the client headers` }
  }
  tightenUserStateMode()
  const replaced =
    current.state === 'legacy'
      ? '; the local stdio server was replaced'
      : current.state === 'ours' && current.staticKey
        ? current.currentKey
          ? `; the key an earlier release wrote into ${claudeUserStatePath()} is taken out of it (copies Claude Code made of that file under ${path.join(claudeHome(), 'backups')} may still hold it)`
          : `; the entry held a key other than this agent's in ${claudeUserStatePath()} (an old one, or another agent's) and was replaced — if it was another agent's, that agent's own credentials still hold it`
        : current.state === 'ours' && current.clientHeaders !== 'current'
          ? '; re-registered with the client headers'
          : ''
  return {
    name: 'mcp',
    status: 'changed',
    detail: `hosted tools registered as user MCP "${MCP_SERVER_NAME}" → ${url} (${keyNote}; named as Claude Code ${CLIENT.version}${replaced})`,
  }
}

/** What `unplace` / uninstall know about the identity whose placement is undone. */
export interface UnplaceIdentity {
  readonly apiKey: string | null
  readonly apiBase: string
}

/** Remove the entry when it is ours (hosted or legacy stdio). A foreign one is never touched. */
export function removeHostedMcp(identity: UnplaceIdentity): PlacementStep {
  const current = inspectHostedMcp(identity.apiKey, identity.apiBase)
  if (current.state === 'missing') return { name: 'mcp', status: 'ok', detail: 'no AgentChat MCP entry to remove' }
  if (current.state === 'foreign') return { name: 'mcp', status: 'skipped', detail: `${current.detail} — left untouched` }
  if (current.state === 'unavailable') return { name: 'mcp', status: 'failed', detail: current.detail }
  const removed = runClaude(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME])
  return removed.ok
    ? { name: 'mcp', status: 'changed', detail: `user MCP "${MCP_SERVER_NAME}" removed (the key is no longer registered with Claude Code)` }
    : { name: 'mcp', status: 'failed', detail: `claude mcp remove failed: ${removed.detail}` }
}

// ─── The manual, as the agentchat skill ─────────────────────────────────────

/** Is there an agentchat skill at all (any version)? What `isWired` asks. */
export function skillPresent(): boolean {
  return fs.existsSync(skillPath())
}

/**
 * The installer's line for a sync. A manual not at the announced version is a
 * warning (`–`), never a failed install: the integration works with the file
 * it has (the old one, or the bundled copy), and `status` / `doctor` keep
 * saying it is stale until a later sync succeeds. Only no manual at all fails.
 */
function manualStep(result: ManualSyncResult, removedLegacy: boolean): PlacementStep {
  const status: PlacementStatus =
    result.state === 'failed' ? 'failed' : result.upToDate === false ? 'warned' : result.written || removedLegacy ? 'changed' : 'ok'
  return { name: 'manual', status, detail: `${describeManualSync(result)}${removedLegacy ? ' (old on-disk manual removed)' : ''}` }
}

/**
 * The manual the served texts announce (`manual`, null when none are in
 * hand), as the agentchat skill. `apiBase` is the API base the texts came
 * from: it decides where a download may go (none from a plain-HTTP base off
 * loopback). Never throws.
 */
export async function placeSkill(manual: ServedManual | null, apiBase: string | null): Promise<PlacementStep> {
  const result = await syncManual({ path: skillPath(), served: manual, apiBase })
  // The hook-based releases kept the manual at <home>/SKILL.md, outside any
  // skills directory. The skill supersedes it.
  const legacy = path.join(identityHome(), LEGACY_MANUAL)
  let removedLegacy = false
  try {
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { force: true })
      removedLegacy = true
    }
  } catch {
    /* a locked file stays inert */
  }
  return manualStep(result, removedLegacy)
}

export function removeSkill(): PlacementStep {
  try {
    let removed = false
    if (fs.existsSync(skillPath())) {
      fs.rmSync(skillDir(), { recursive: true, force: true })
      removed = true
    }
    const legacy = path.join(identityHome(), LEGACY_MANUAL)
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { force: true })
      removed = true
    }
    return { name: 'manual', status: removed ? 'changed' : 'ok', detail: removed ? 'agentchat skill removed' : 'no agentchat skill to remove' }
  } catch (err) {
    return { name: 'manual', status: 'failed', detail: `could not remove the agentchat skill: ${String(err)}` }
  }
}

// ─── The identity line ──────────────────────────────────────────────────────

export function placeIdentityLine(handle: string, identityLine: string | null): PlacementStep {
  if (identityLine === null) {
    // The line is the server's. Without it (offline, nothing cached) nothing is
    // written: `doctor --fix` places it once the texts can be fetched.
    return {
      name: 'identity',
      status: 'skipped',
      detail: `identity line for @${handle} not written — the served texts (GET /v1/texts) could not be fetched and none are cached; run \`doctor --fix\` once online`,
    }
  }
  try {
    // Current means exactly this block (handle line and served line) and no
    // second AgentChat block. Anything else — an older shape, older words, a
    // stale extra block — is rewritten: in place, atomically.
    const current = anchorIsCurrentAt(anchorFile(), identityLine, handle)
    if (!current) writeAnchor(anchorFile(), renderAnchorBlock(identityLine, handle), handle)
    return { name: 'identity', status: current ? 'ok' : 'changed', detail: `identity line for @${handle} in ${anchorFile()}` }
  } catch (err) {
    return { name: 'identity', status: 'failed', detail: `could not write the identity line to ${anchorFile()}: ${String(err)}` }
  }
}

/** No identity yet: the wizard's offer (or the silent variant after --not-now). */
export function placeOffer(): PlacementStep {
  try {
    const declined = offerDeclined(identityHome())
    writeAnchor(anchorFile(), declined ? renderDeclinedBlock(hostCopy()) : renderUnregisteredBlock(hostCopy()))
    return { name: 'identity', status: 'changed', detail: declined ? `${path.basename(anchorFile())}: AgentChat present, not asking` : `${path.basename(anchorFile())}: setup offer (no account yet)` }
  } catch (err) {
    return { name: 'identity', status: 'failed', detail: `could not write ${anchorFile()}: ${String(err)}` }
  }
}

// ─── Legacy wiring from the hook-based releases before the listener ─────────

interface HookLeaf {
  type?: string
  command?: string
  args?: unknown[]
}
interface HookGroup {
  matcher?: string
  hooks?: HookLeaf[]
  [key: string]: unknown
}

function leafIsOurs(leaf: HookLeaf): boolean {
  return (
    leaf.type === 'command' &&
    leaf.command === 'node' &&
    Array.isArray(leaf.args) &&
    leaf.args.some((arg) => typeof arg === 'string' && arg.replace(/\\/g, '/').endsWith('/agentchat/bin/agentchat.mjs'))
  )
}

/** Remove only our leaves; a user's co-located hooks stay. Pure. */
export function withoutLegacyHooks(doc: Record<string, unknown>): { doc: Record<string, unknown>; removed: number } {
  const hooks = doc['hooks']
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { doc, removed: 0 }
  let removed = 0
  const nextHooks: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups
      continue
    }
    const kept: HookGroup[] = []
    for (const group of groups as HookGroup[]) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group)
        continue
      }
      const leaves = group.hooks.filter((leaf) => {
        const ours = leafIsOurs(leaf)
        if (ours) removed += 1
        return !ours
      })
      if (leaves.length === 0) continue
      kept.push(leaves.length === group.hooks.length ? group : { ...group, hooks: leaves })
    }
    if (kept.length > 0) nextHooks[event] = kept
  }
  const next = { ...doc }
  if (Object.keys(nextHooks).length > 0) next['hooks'] = nextHooks
  else delete next['hooks']
  return { doc: next, removed }
}

export function legacyHooksPresent(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>
    return withoutLegacyHooks(parsed).removed > 0
  } catch {
    return false
  }
}

export function legacyBundlePresent(): boolean {
  return fs.existsSync(path.join(identityHome(), LEGACY_BUNDLE))
}

/** Strip the hook-based releases' hooks and stable CLI bundle. Idempotent. */
export function removeLegacyWiring(): PlacementStep | null {
  const notes: string[] = []
  const file = settingsPath()
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const { doc, removed } = withoutLegacyHooks(parsed as Record<string, unknown>)
        if (removed > 0) {
          let mode = 0o600
          try {
            mode = fs.statSync(file).mode & 0o777
          } catch {
            /* keep private */
          }
          if (Object.keys(doc).length === 0) fs.unlinkSync(file)
          else atomicWriteFile(file, JSON.stringify(doc, null, 2) + '\n', mode)
          notes.push(`${removed} lifecycle hook${removed === 1 ? '' : 's'} removed from settings.json (receiving no longer needs hooks)`)
        }
      }
    } catch (err) {
      return { name: 'legacy', status: 'failed', detail: `${file} could not be read as JSON; the old AgentChat hooks were left in place: ${String(err)}` }
    }
  }
  const bundle = path.join(identityHome(), LEGACY_BUNDLE)
  if (fs.existsSync(bundle)) {
    try {
      fs.rmSync(bundle, { force: true })
      notes.push('stable CLI bundle removed')
    } catch {
      /* a locked file stays inert */
    }
  }
  if (notes.length === 0) return null
  log.debug(`legacy cleanup: ${notes.join('; ')}`)
  return { name: 'legacy', status: 'changed', detail: notes.join('; ') }
}

// ─── What runs leave behind ─────────────────────────────────────────────────

/**
 * An answer run writes its own tool config (it holds the key), and an answer
 * or own run its identity line, into `<identity home>/presets/` and removes
 * them when it ends; a run cut off (power loss, a killed daemon) leaves them
 * there. Logout takes them out with the key; uninstall with the rest. Null
 * when there were none.
 */
export function removeAnswerRunLeftovers(): PlacementStep | null {
  const dir = path.dirname(answerToolConfigFor(identityHome()))
  const { removed, failed } = removeAnswerRunFiles(identityHome())
  if (failed.length > 0) {
    return { name: 'runs', status: 'failed', detail: `could not remove ${failed.join(', ')} from ${dir} (left by a run; an answer run's tool config there holds the key) — delete ${failed.length === 1 ? 'it' : 'them'} by hand` }
  }
  if (removed.length === 0) return null
  return { name: 'runs', status: 'changed', detail: `removed ${removed.length} file${removed.length === 1 ? '' : 's'} a run left in ${dir} (an answer run's tool config, a run's identity line)` }
}

// ─── All together ───────────────────────────────────────────────────────────

/**
 * Place everything for the current identity (or the offer when there is none).
 * Never throws; each step reports. The hosted MCP entry needs the key, so it
 * is placed only with an identity. `manual` is what the served texts announce
 * (null when none are in hand: an existing skill is kept, a missing one gets
 * the bundled copy).
 */
export async function placeAll(identity: PlacementIdentity | null, manual: ServedManual | null): Promise<PlacementStep[]> {
  const steps: PlacementStep[] = []
  const legacy = removeLegacyWiring()
  if (legacy) steps.push(legacy)
  steps.push(await placeSkill(manual, identity?.apiBase ?? null))
  if (identity) {
    steps.push(placeHostedMcp(identity))
    steps.push(placeIdentityLine(identity.handle, identity.identityLine))
  } else {
    steps.push(placeOffer())
  }
  return steps
}

/**
 * Logout: the key leaves Claude Code (the MCP entry, and any tool config an
 * answer run left behind); the manual and the skill stay.
 * `identity` is the identity as it was BEFORE the credential was cleared
 * (agent-core hands it over), so the entry is recognised by its key and its
 * server rather than by a guessed default base.
 */
export function unplaceIdentity(identity: UnplaceIdentity): PlacementStep[] {
  const steps = [removeHostedMcp(identity)]
  const leftovers = removeAnswerRunLeftovers()
  if (leftovers) steps.push(leftovers)
  steps.push(placeOffer())
  return steps
}

/** Uninstall: everything this integration placed, the identity line included. */
export function removePlacement(identity: UnplaceIdentity): PlacementStep[] {
  const steps: PlacementStep[] = []
  const legacy = removeLegacyWiring()
  if (legacy) steps.push(legacy)
  steps.push(removeHostedMcp(identity))
  const leftovers = removeAnswerRunLeftovers()
  if (leftovers) steps.push(leftovers)
  steps.push(removeSkill())
  try {
    // The helper holds no key; with the entry gone nothing runs it.
    fs.rmSync(headersHelperPath(), { force: true })
  } catch {
    /* a locked file stays inert */
  }
  try {
    steps.push({
      name: 'identity',
      status: removeAnchorAt(anchorFile()) === 'removed' ? 'changed' : 'ok',
      detail: `${path.basename(anchorFile())} AgentChat block removed`,
    })
  } catch (err) {
    steps.push({ name: 'identity', status: 'failed', detail: `could not remove the AgentChat block from ${anchorFile()}: ${err instanceof Error ? err.message : String(err)} — remove it by hand` })
  }
  return steps
}

export interface PlacementCheck {
  readonly name: 'identity' | 'manual' | 'mcp' | 'legacy'
  readonly ok: boolean
  readonly detail: string
  /** The doctor verdict when it is not the default mapping of `ok`. */
  readonly verdict?: 'PASS' | 'WARN' | 'FAIL'
}

/**
 * The identity line's check. A CLAUDE.md that cannot be read (permissions,
 * a symlink loop, not UTF-8) fails this check alone: every other check, and
 * every repair `doctor --fix` makes, still runs.
 */
function identityCheck(identity: PlacementIdentity): PlacementCheck {
  let claimed: string | null
  let current: boolean | null
  try {
    // The served template lets an unmarked block in today's words be read as
    // this agent's; without texts, the handle line and the older wordings
    // still are.
    claimed = readAnchorHandleAt(anchorFile(), identity.identityLineTemplate)
    // null: the served texts were unavailable, so only the handle can be checked.
    current = identity.identityLine === null ? null : anchorIsCurrentAt(anchorFile(), identity.identityLine, identity.handle)
  } catch (err) {
    return { name: 'identity', ok: false, verdict: 'FAIL', detail: `cannot read ${anchorFile()}: ${err instanceof Error ? err.message : String(err)}` }
  }
  // This agent's block in older words (or without the handle line, or next
  // to a second AgentChat block) still tells the agent who it is: not
  // current, nothing broken — a WARN (`–`), as the shared doctor reports it.
  // A wrong handle or no block is a FAIL.
  const older = current === false && claimed === identity.handle
  return {
    name: 'identity',
    ok: current === true || (current === null && claimed === identity.handle),
    ...(older ? { verdict: 'WARN' as const } : {}),
    detail: current === true
      ? `identity line for @${identity.handle} in ${anchorFile()}`
      : current === null && claimed === identity.handle
        ? `identity line for @${identity.handle} in ${anchorFile()} (served texts unavailable — currency not checked)`
      : claimed === null
        ? `identity line missing from ${anchorFile()}`
        : claimed !== identity.handle
          ? `${anchorFile()} says @${claimed} but this agent is @${identity.handle}`
          : `${anchorFile()} carries an older identity text (or a second AgentChat block) — install or \`doctor --fix\` rewrites it`,
  }
}

/**
 * For `status` and `doctor`: is everything where it should be? `manual` is
 * what the served texts announce (null when none are in hand), so the skill
 * reads `current (2.2.0)` or `stale (have 2.1.2, served 2.2.0)`.
 */
export function checkPlacement(identity: PlacementIdentity | null, manual: ServedManual | null): PlacementCheck[] {
  const checks: PlacementCheck[] = []
  if (identity) {
    checks.push(identityCheck(identity))
  }
  const skill = checkManual({ path: skillPath(), served: manual, apiBase: identity?.apiBase ?? null })
  // `unchecked` (nothing announced: no account yet, or offline with nothing
  // cached) is a WARN with no repair to suggest; `stale` and `missing` are
  // what `doctor --fix` repairs.
  checks.push({ name: 'manual', ok: skill.state === 'current' || skill.state === 'unchecked', verdict: skill.verdict, detail: skill.detail })
  const mcp = inspectHostedMcp(identity?.apiKey ?? null, identity?.apiBase ?? 'https://api.agentchat.me')
  const headerHint = Object.entries(clientHeaders()).map(([name, value]) => `--header "${name}: ${value}"`).join(' ')
  // Only when everything else about the entry is right: run its helper the way Claude Code will.
  const helperProblem =
    mcp.state === 'ours' && identity !== null && !mcp.staticKey && mcp.helper === 'current'
      ? headersHelperProblem(readEntryField('headersHelper'), identity.apiKey)
      : null
  checks.push({
    name: 'mcp',
    ok: mcp.state === 'ours' ? (identity === null || (!mcp.staticKey && mcp.helper === 'current' && helperProblem === null)) && mcp.clientHeaders !== 'missing' : false,
    // A user-scope "agentchat" that is not this integration's (another URL,
    // another helper) is never touched; the check says, too, when it does not
    // name this runtime to the hosted tools.
    detail:
      mcp.state === 'ours'
        ? identity !== null && mcp.staticKey
          ? mcp.currentKey
            ? `user MCP "${MCP_SERVER_NAME}" holds this agent's key in ${claudeUserStatePath()} (an earlier release's registration) — install or \`doctor --fix\` takes it out and has Claude Code read it from ${path.join(identityHome(), 'credentials')}`
            : `user MCP "${MCP_SERVER_NAME}" carries a different key than this agent's credentials, in ${claudeUserStatePath()}`
          : identity !== null && mcp.helper !== 'current'
            ? `user MCP "${MCP_SERVER_NAME}" ${mcp.helper === 'stale' ? `asks a headers helper that is out of date or whose Node is gone (${headersHelperPath()})` : 'has no headers helper of this integration'}, so no key reaches the hosted tools`
            : helperProblem !== null
              ? `user MCP "${MCP_SERVER_NAME}" → ${mcp.url}: ${helperProblem}`
              : mcp.clientHeaders === 'missing'
                ? `user MCP "${MCP_SERVER_NAME}" → ${mcp.url} does not send ${Object.keys(clientHeaders())[0]}, so the hosted tools take this agent for an unknown client and show it the wake-webhook tools`
                : `hosted tools registered as user MCP "${MCP_SERVER_NAME}" → ${mcp.url}${identity !== null ? ` (the key stays in ${path.join(identityHome(), 'credentials')}; Claude Code asks ${headersHelperPath()} for it)` : ''}${mcp.clientHeaders === 'stale' ? ` (named by an earlier release; install or \`doctor --fix\` names it as Claude Code ${CLIENT.version})` : ''}`
        : mcp.state === 'legacy'
          ? `user MCP "${MCP_SERVER_NAME}" is the old local stdio server`
          : mcp.state === 'missing'
            ? `no user MCP "${MCP_SERVER_NAME}" — the agent has no AgentChat tools`
            : mcp.state === 'foreign' && mcp.clientHeaders === 'missing'
              ? `${mcp.detail}; it does not send ${Object.keys(clientHeaders())[0]}, so the hosted tools show this agent the wake-webhook tools — add ${headerHint} to it`
              : mcp.detail,
  })
  const leftovers = [legacyHooksPresent() ? 'hooks in settings.json' : null, legacyBundlePresent() ? 'stable CLI bundle' : null].filter(
    (v): v is string => v !== null,
  )
  checks.push({
    name: 'legacy',
    ok: leftovers.length === 0,
    detail: leftovers.length === 0 ? 'no pre-0.1.0 wiring left' : `pre-0.1.0 wiring still present: ${leftovers.join(', ')}`,
  })
  return checks
}

/** ✓ done / current, – not done but nothing broken (a stale manual, an unchecked one), ✗ failed / missing. */
export function placementMark(step: PlacementStep | PlacementCheck): string {
  if ('status' in step) return step.status === 'failed' ? '✗' : step.status === 'skipped' || step.status === 'warned' ? '–' : '✓'
  if (step.verdict !== undefined) return step.verdict === 'PASS' ? '✓' : step.verdict === 'WARN' ? '–' : '✗'
  return step.ok ? '✓' : '✗'
}

export function formatPlacement(steps: readonly (PlacementStep | PlacementCheck)[]): string[] {
  return steps.map((step) => `  ${placementMark(step)} ${step.name}: ${step.detail}`)
}
