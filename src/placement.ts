import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  MANUAL,
  MANUAL_URL,
  atomicWriteFile,
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
  writeAnchor,
} from '@agentchatme/agent-core'
import {
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

// ─── Placement: the four texts, where Claude Code loads them ────────────────
//
// 1. **The identity line** — the manual's anchor text, fenced, in
//    `~/.claude/CLAUDE.md` (Claude Code's always-loaded user instructions).
// 2. **The manual** — `https://agentchat.me/skill.md` verbatim as the personal
//    skill `~/.claude/skills/agentchat/SKILL.md` (code.claude.com/docs/en/skills.md:
//    personal skills live at `~/.claude/skills/<skill-name>/SKILL.md`, loaded on
//    demand by description).
// 3. **The hosted tool server** — the user-scope MCP server `agentchat`,
//    transport HTTP, `https://api.agentchat.me/mcp`, registered through Claude
//    Code's own CLI: `claude mcp add --transport http --scope user agentchat
//    <url> --header "Authorization: Bearer <key>"` (code.claude.com/docs/en/mcp.md).
//    Claude Code stores user-scope servers in `~/.claude.json`, so the key lands
//    in that file; this module tightens its mode to 0600 afterwards (best effort;
//    Claude Code may rewrite the file with its own mode). There is no documented
//    way to keep a user-scope header out of that file short of a `headersHelper`
//    command, which would need a separate key store — a later refinement.
// 4. **The key** — already in the identity home's `credentials` (0600) and, by
//    the registration above, in the MCP entry.
//
// Legacy cleanup on upgrade: the four lifecycle hooks the previous release wrote
// into `settings.json`, the stdio `mcp-proxy` MCP entry, the stable CLI bundle
// under the identity home, and the old on-disk manual at `<home>/SKILL.md`.
// Receiving no longer needs hooks.

export type PlacementStatus = 'ok' | 'changed' | 'skipped' | 'failed'

export interface PlacementStep {
  readonly name: 'identity' | 'skill' | 'mcp' | 'legacy'
  readonly status: PlacementStatus
  readonly detail: string
}

export interface PlacementIdentity {
  readonly handle: string
  readonly apiKey: string
  readonly apiBase: string
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

// ─── The hosted MCP entry ───────────────────────────────────────────────────

export type McpEntryState =
  | { state: 'missing' }
  | { state: 'ours'; url: string; currentKey: boolean }
  | { state: 'legacy' }
  | { state: 'foreign'; detail: string }
  | { state: 'unavailable'; detail: string }

function readUserState(): Record<string, unknown> | null {
  const raw = fs.readFileSync(claudeUserStatePath(), 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
  return parsed as Record<string, unknown>
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
 * this identity's hosted MCP URL, OR one carrying this identity's key in its
 * `Authorization` header — the key is the stronger evidence, and it is what
 * keeps a non-default `api_base` registration from being left behind as
 * "foreign" on logout. `apiKey` also decides `currentKey`.
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
  if (typeof entry !== 'object' || Array.isArray(entry)) return { state: 'foreign', detail: 'the user-scope server named "agentchat" is not an object' }
  const record = entry as Record<string, unknown>
  if (isLegacyStdioEntry(record)) return { state: 'legacy' }
  const type = record['type']
  const url = record['url']
  const headers = record['headers']
  const auth =
    headers && typeof headers === 'object' && !Array.isArray(headers)
      ? ((headers as Record<string, unknown>)['Authorization'] ?? (headers as Record<string, unknown>)['authorization'])
      : undefined
  const currentKey = apiKey !== null && typeof auth === 'string' && auth === `Bearer ${apiKey}`
  const isHttp = type === 'http' || type === 'streamable-http'
  if (isHttp && typeof url === 'string' && (url === hostedMcpUrl(apiBase) || currentKey)) {
    return { state: 'ours', url, currentKey }
  }
  return { state: 'foreign', detail: `the user-scope server named "agentchat" points at ${typeof url === 'string' ? url : 'a different command'} and is not this integration's` }
}

function tightenUserStateMode(): void {
  // The key is in this file now. Claude Code may rewrite it with its own mode
  // later; this is the best an installer can do without a documented
  // user-scope secret store.
  try {
    fs.chmodSync(claudeUserStatePath(), 0o600)
  } catch {
    /* absent or not ours to chmod */
  }
}

/** Register (or re-register with the current key) the hosted MCP server at user scope. */
export function placeHostedMcp(identity: PlacementIdentity): PlacementStep {
  const current = inspectHostedMcp(identity.apiKey, identity.apiBase)
  if (current.state === 'unavailable') return { name: 'mcp', status: 'failed', detail: current.detail }
  if (current.state === 'foreign') {
    return { name: 'mcp', status: 'skipped', detail: `${current.detail} — left untouched; rename or remove it, then re-run` }
  }
  if (current.state === 'ours' && current.currentKey) {
    tightenUserStateMode()
    return { name: 'mcp', status: 'ok', detail: `hosted tools registered as user MCP "${MCP_SERVER_NAME}" → ${current.url}` }
  }
  if (current.state === 'ours' || current.state === 'legacy') {
    const removed = runClaude(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME])
    if (!removed.ok) return { name: 'mcp', status: 'failed', detail: `could not replace the existing "${MCP_SERVER_NAME}" MCP entry: ${removed.detail}` }
  }
  const url = hostedMcpUrl(identity.apiBase)
  const added = runClaude(['mcp', 'add', '--transport', 'http', '--scope', 'user', MCP_SERVER_NAME, url, '--header', `Authorization: Bearer ${identity.apiKey}`])
  if (!added.ok) return { name: 'mcp', status: 'failed', detail: `claude mcp add failed: ${added.detail}` }
  const after = inspectHostedMcp(identity.apiKey, identity.apiBase)
  if (after.state !== 'ours' || !after.currentKey) {
    return { name: 'mcp', status: 'failed', detail: `claude mcp add reported success but ${claudeUserStatePath()} does not carry the entry with this key` }
  }
  tightenUserStateMode()
  return {
    name: 'mcp',
    status: 'changed',
    detail: `hosted tools registered as user MCP "${MCP_SERVER_NAME}" → ${url} (Authorization header with this agent's key${current.state === 'legacy' ? '; the local stdio server was replaced' : ''})`,
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

export function skillIsCurrent(): boolean {
  try {
    return fs.readFileSync(skillPath(), 'utf-8') === MANUAL
  } catch {
    return false
  }
}

export function placeSkill(): PlacementStep {
  try {
    const current = skillIsCurrent()
    if (!current) {
      fs.mkdirSync(skillDir(), { recursive: true })
      atomicWriteFile(skillPath(), MANUAL, 0o644)
    }
    // The previous release kept the manual at <home>/SKILL.md, outside any
    // skills directory. The skill supersedes it.
    const legacy = path.join(identityHome(), LEGACY_MANUAL)
    let removedLegacy = false
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { force: true })
      removedLegacy = true
    }
    return {
      name: 'skill',
      status: current && !removedLegacy ? 'ok' : 'changed',
      detail: `manual (${MANUAL_URL}, verbatim) as the agentchat skill at ${skillPath()}${removedLegacy ? ' (old on-disk manual removed)' : ''}`,
    }
  } catch (err) {
    return { name: 'skill', status: 'failed', detail: `could not write the manual to ${skillPath()}: ${String(err)}` }
  }
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
    return { name: 'skill', status: removed ? 'changed' : 'ok', detail: removed ? 'agentchat skill removed' : 'no agentchat skill to remove' }
  } catch (err) {
    return { name: 'skill', status: 'failed', detail: `could not remove the agentchat skill: ${String(err)}` }
  }
}

// ─── The identity line ──────────────────────────────────────────────────────

export function placeIdentityLine(handle: string): PlacementStep {
  try {
    const current = anchorIsCurrentAt(anchorFile(), handle)
    if (!current) writeAnchor(anchorFile(), renderAnchorBlock(handle), handle)
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

// ─── Legacy wiring from the pre-doorbell releases ───────────────────────────

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

/** Strip the previous release's hooks and stable CLI bundle. Idempotent. */
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

// ─── All together ───────────────────────────────────────────────────────────

/**
 * Place everything for the current identity (or the offer when there is none).
 * Never throws; each step reports. The hosted MCP entry needs the key, so it
 * is placed only with an identity.
 */
export function placeAll(identity: PlacementIdentity | null): PlacementStep[] {
  const steps: PlacementStep[] = []
  const legacy = removeLegacyWiring()
  if (legacy) steps.push(legacy)
  steps.push(placeSkill())
  if (identity) {
    steps.push(placeHostedMcp(identity))
    steps.push(placeIdentityLine(identity.handle))
  } else {
    steps.push(placeOffer())
  }
  return steps
}

/**
 * Logout: the key leaves Claude Code; the manual and the skill stay.
 * `identity` is the identity as it was BEFORE the credential was cleared
 * (agent-core hands it over), so the entry is recognised by its key and its
 * server rather than by a guessed default base.
 */
export function unplaceIdentity(identity: UnplaceIdentity): PlacementStep[] {
  const steps = [removeHostedMcp(identity)]
  steps.push(placeOffer())
  return steps
}

/** Uninstall: everything this integration placed, the identity line included. */
export function removePlacement(identity: UnplaceIdentity): PlacementStep[] {
  const steps: PlacementStep[] = []
  const legacy = removeLegacyWiring()
  if (legacy) steps.push(legacy)
  steps.push(removeHostedMcp(identity))
  steps.push(removeSkill())
  steps.push({
    name: 'identity',
    status: removeAnchorAt(anchorFile()) === 'removed' ? 'changed' : 'ok',
    detail: `${path.basename(anchorFile())} AgentChat block removed`,
  })
  return steps
}

export interface PlacementCheck {
  readonly name: 'identity' | 'skill' | 'mcp' | 'legacy'
  readonly ok: boolean
  readonly detail: string
}

/** For `status` and `doctor`: is everything where it should be? */
export function checkPlacement(identity: PlacementIdentity | null): PlacementCheck[] {
  const checks: PlacementCheck[] = []
  if (identity) {
    const claimed = readAnchorHandleAt(anchorFile())
    const current = anchorIsCurrentAt(anchorFile(), identity.handle)
    checks.push({
      name: 'identity',
      ok: current,
      detail: current
        ? `identity line for @${identity.handle} in ${anchorFile()}`
        : claimed === null
          ? `identity line missing from ${anchorFile()}`
          : claimed !== identity.handle
            ? `${anchorFile()} says @${claimed} but this agent is @${identity.handle}`
            : `${anchorFile()} carries an older identity text`,
    })
  }
  checks.push({
    name: 'skill',
    ok: skillIsCurrent(),
    detail: skillIsCurrent() ? `manual current at ${skillPath()}` : `manual missing or stale at ${skillPath()}`,
  })
  const mcp = inspectHostedMcp(identity?.apiKey ?? null, identity?.apiBase ?? 'https://api.agentchat.me')
  checks.push({
    name: 'mcp',
    ok: mcp.state === 'ours' && (identity === null || mcp.currentKey),
    detail:
      mcp.state === 'ours'
        ? identity === null || mcp.currentKey
          ? `hosted tools registered as user MCP "${MCP_SERVER_NAME}" → ${mcp.url}`
          : `user MCP "${MCP_SERVER_NAME}" carries a different key than this agent's credentials`
        : mcp.state === 'legacy'
          ? `user MCP "${MCP_SERVER_NAME}" is the old local stdio server`
          : mcp.state === 'missing'
            ? `no user MCP "${MCP_SERVER_NAME}" — the agent has no AgentChat tools`
            : mcp.detail,
  })
  const leftovers = [legacyHooksPresent() ? 'hooks in settings.json' : null, legacyBundlePresent() ? 'stable CLI bundle' : null].filter(
    (v): v is string => v !== null,
  )
  checks.push({
    name: 'legacy',
    ok: leftovers.length === 0,
    detail: leftovers.length === 0 ? 'no pre-doorbell wiring left' : `pre-doorbell wiring still present: ${leftovers.join(', ')}`,
  })
  return checks
}

export function formatPlacement(steps: readonly (PlacementStep | PlacementCheck)[]): string[] {
  return steps.map((step) => {
    const mark = 'status' in step ? (step.status === 'failed' ? '✗' : step.status === 'skipped' ? '–' : '✓') : step.ok ? '✓' : '✗'
    return `  ${mark} ${step.name}: ${step.detail}`
  })
}
