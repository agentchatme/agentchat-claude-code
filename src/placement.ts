import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  atomicWriteFile,
  checkManual,
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

/**
 * `warned`: done as far as it can be and nothing broken, but not current — a
 * manual left at its version (or the bundled copy) because the announced one
 * could not be downloaded. Printed as a warning; never fails an install.
 */
export type PlacementStatus = 'ok' | 'changed' | 'warned' | 'skipped' | 'failed'

export interface PlacementStep {
  readonly name: 'identity' | 'manual' | 'mcp' | 'legacy'
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
  // The previous release kept the manual at <home>/SKILL.md, outside any
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
  readonly name: 'identity' | 'manual' | 'mcp' | 'legacy'
  readonly ok: boolean
  readonly detail: string
  /** The doctor verdict when it is not the default mapping of `ok`. */
  readonly verdict?: 'PASS' | 'WARN' | 'FAIL'
}

/**
 * For `status` and `doctor`: is everything where it should be? `manual` is
 * what the served texts announce (null when none are in hand), so the skill
 * reads `current (2.2.0)` or `stale (have 2.1.2, served 2.2.0)`.
 */
export function checkPlacement(identity: PlacementIdentity | null, manual: ServedManual | null): PlacementCheck[] {
  const checks: PlacementCheck[] = []
  if (identity) {
    // The served template lets an unmarked block in today's words be read as
    // this agent's; without texts, the handle line and the older wordings
    // still are.
    const claimed = readAnchorHandleAt(anchorFile(), identity.identityLineTemplate)
    // null: the served texts were unavailable, so only the handle can be checked.
    const current = identity.identityLine === null ? null : anchorIsCurrentAt(anchorFile(), identity.identityLine, identity.handle)
    checks.push({
      name: 'identity',
      ok: current === true || (current === null && claimed === identity.handle),
      detail: current === true
        ? `identity line for @${identity.handle} in ${anchorFile()}`
        : current === null && claimed === identity.handle
          ? `identity line for @${identity.handle} in ${anchorFile()} (served texts unavailable — currency not checked)`
        : claimed === null
          ? `identity line missing from ${anchorFile()}`
          : claimed !== identity.handle
            ? `${anchorFile()} says @${claimed} but this agent is @${identity.handle}`
            : `${anchorFile()} carries an older identity text`,
    })
  }
  const skill = checkManual({ path: skillPath(), served: manual, apiBase: identity?.apiBase ?? null })
  // `unchecked` (nothing announced: no account yet, or offline with nothing
  // cached) is a WARN with no repair to suggest; `stale` and `missing` are
  // what `doctor --fix` repairs.
  checks.push({ name: 'manual', ok: skill.state === 'current' || skill.state === 'unchecked', verdict: skill.verdict, detail: skill.detail })
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
