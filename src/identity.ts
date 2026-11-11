import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  alwaysOnOptedOut,
  alwaysOnState,
  createIdentityCommands,
  fetchServedTexts,
  integrationDisabledBy,
  INTEGRATION_ENV,
  integrationStatusAge,
  probeHostedMcp,
  readCredentials,
  readIntegrationStatus,
  recordOfferDeclined,
  renderAnchorBlock,
  renderDeclinedBlock,
  resolveIdentity,
  writeAnchor,
  type DoctorCheck,
  type DoctorContext,
  type DoctorOpts,
  type HostProfile,
  type ServedManual,
  type StatusContext,
} from '@agentchatme/agent-core'
import { CLIENT, identityHome, anchorFile, claudeConfigOverride, invocation, LABEL, legacyRunWorkdirFor, resolveRunWorkdir, runWorkdirFor } from './host.js'
import { checkPlacement, placeAll, placementMark, skillPresent, unplaceIdentity, type PlacementIdentity } from './placement.js'
import { claudeIsLoggedIn, deniedAncestorOf, denyReadPathsFor, inspectClaudeRuntime } from './runner.js'
import { ensureListenerService, listenerServiceCurrent } from './service.js'
import { VERSION } from './version.js'

// ─── This agent, described once ─────────────────────────────────────────────
//
// register / login / recover / status / logout / doctor are a contract with the
// AgentChat server, so the flows live in @agentchatme/agent-core and this file
// only says which agent they act on and how to PLACE for it: every time the key
// changes, the hosted MCP entry is re-registered with the new key, the manual is
// brought to the version the served texts announce and the identity line
// rewritten.

/** The served identity texts a placement check reads against: what `StatusContext` / `DoctorContext` carry. */
export type ServedIdentityTexts = Pick<StatusContext, 'identityLine' | 'identityLineTemplate'>

const NO_IDENTITY_TEXTS: ServedIdentityTexts = { identityLine: null, identityLineTemplate: null }

export function currentPlacementIdentity(texts: ServedIdentityTexts = NO_IDENTITY_TEXTS): PlacementIdentity | null {
  const identity = resolveIdentity(identityHome())
  if (identity === null || identity.handle === null) return null
  return {
    handle: identity.handle,
    apiKey: identity.apiKey,
    apiBase: identity.apiBase,
    identityLine: texts.identityLine,
    identityLineTemplate: texts.identityLineTemplate,
  }
}

/**
 * The identity plus what the served texts say for it — the identity line and
 * the manual they announce — fetched now, else from the identity-home cache,
 * else null. Without an identity nothing is fetched (the texts need a key):
 * the manual is then unannounced, so an existing skill is kept as it is.
 */
export async function currentServedPlacement(): Promise<{ identity: PlacementIdentity | null; manual: ServedManual | null }> {
  const identity = currentPlacementIdentity()
  if (identity === null) return { identity: null, manual: null }
  const loaded = await fetchServedTexts({ home: identityHome(), apiKey: identity.apiKey, apiBase: identity.apiBase, client: CLIENT })
  return {
    identity: { ...identity, identityLine: loaded?.texts.identity_line ?? null, identityLineTemplate: loaded?.texts.identity_line_template ?? null },
    manual: loaded?.texts.manual ?? null,
  }
}

const profile: HostProfile = {
  label: LABEL,
  id: 'claude-code',
  client: CLIENT,
  home: identityHome,
  anchorFile,
  invocation,
  renderAnchor: renderAnchorBlock,
  isWired: skillPresent,
  // agent-core fetches the served texts (cache fallback) once and hands over
  // the identity line and the manual they announce. Writing the block needs no
  // template (it is found by its fences), so none is passed here.
  place: async (handle, apiKey, identityLine, manual) => {
    const identity = resolveIdentity(identityHome())
    const steps = await placeAll({ handle, apiKey, apiBase: identity?.apiBase ?? 'https://api.agentchat.me', identityLine, identityLineTemplate: null }, manual)
    return steps.map((s) => `  ${s.status === 'failed' ? 'FAILED' : s.name}: ${s.detail}`)
  },
  // agent-core resolves the identity BEFORE it clears the credential and hands
  // it here: the MCP entry is recognised by this key and this server.
  unplace: (identity) =>
    unplaceIdentity({
      apiKey: identity?.apiKey ?? null,
      apiBase: identity?.apiBase ?? process.env['AGENTCHAT_API_BASE']?.trim() ?? 'https://api.agentchat.me',
    }).map((s) => `  ${s.name}: ${s.detail}`),
  logoutHints: () => [`To remove the integration too, run \`${invocation()} uninstall\`.`],
  extraDoctorChecks: async (ctx: DoctorContext): Promise<DoctorCheck[]> => [
    ...runtimeChecks(),
    ...(await placementChecks(ctx.fix === true, ctx, ctx.manual)),
    serviceCheck(ctx.fix === true),
    workdirCheck(ctx.fix === true),
    integrationCheck(),
  ],
  // The shared status already fetched the served texts once; the placement
  // checks reuse the identity line, its template and the announced manual
  // rather than fetching `/v1/texts` again.
  extraStatus: async (ctx: StatusContext): Promise<string[]> => {
    const identity = currentPlacementIdentity(ctx)
    const lines = ['Placement:', ...checkPlacement(identity, ctx.manual).map((c) => `  ${placementMark(c)} ${c.name}: ${c.detail}`)]
    const workdir = workdirCheck(false)
    lines.push(`  ${workdir.verdict === 'PASS' ? '✓' : '✗'} run workdir: ${workdir.detail}`)
    if (identity) {
      const reach = await hostedMcpReachCheck()
      lines.push(`  ${reach.verdict === 'PASS' ? '✓' : '✗'} hosted MCP: ${reach.detail}`)
    }
    return lines
  },
}

function concise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function runtimeChecks(): DoctorCheck[] {
  const version = inspectClaudeRuntime(claudeConfigOverride())
  if (!version.ok) {
    return [
      { name: 'claude-cli', verdict: 'FAIL', detail: version.detail },
      { name: 'claude-auth', verdict: 'FAIL', detail: 'cannot check until the Claude CLI works' },
    ]
  }
  const authenticated = claudeIsLoggedIn(claudeConfigOverride())
  return [
    { name: 'claude-cli', verdict: 'PASS', detail: concise(version.detail) || 'available' },
    {
      name: 'claude-auth',
      verdict: authenticated ? 'PASS' : 'FAIL',
      detail: authenticated ? 'Claude Code is signed in; headless runs can start' : 'Claude Code is not signed in — run `claude` once and sign in',
    },
  ]
}

async function placementChecks(fix: boolean, texts: ServedIdentityTexts, manual: ServedManual | null): Promise<DoctorCheck[]> {
  const identity = currentPlacementIdentity(texts)
  if (fix) await placeAll(identity, manual)
  const checks: DoctorCheck[] = checkPlacement(identity, manual)
    .filter((c) => c.name !== 'identity') // the shared doctor already reports the identity line
    .map((c) => ({
      name: c.name === 'mcp' ? 'hosted-mcp' : c.name,
      verdict: c.verdict ?? (c.ok ? 'PASS' : c.name === 'legacy' ? 'WARN' : identity ? 'FAIL' : 'WARN'),
      detail: c.ok ? c.detail : `${c.detail} — run \`${invocation()}${fix ? '' : ' doctor --fix'}\``,
    }))
  return checks
}

/** One MCP `initialize` with the key: can this agent's tools be reached from here? */
export async function hostedMcpReachCheck(): Promise<DoctorCheck> {
  const identity = currentPlacementIdentity()
  if (identity === null) return { name: 'hosted-mcp-reach', verdict: 'WARN', detail: 'no identity — nothing to probe with' }
  const probe = await probeHostedMcp({ apiKey: identity.apiKey, apiBase: identity.apiBase, client: CLIENT, clientName: '@agentchatme/claude-code doctor', clientVersion: VERSION })
  return probe.ok
    ? { name: 'hosted-mcp-reach', verdict: 'PASS', detail: `initialize ok${probe.serverName ? ` (${probe.serverName}${probe.serverVersion ? ` ${probe.serverVersion}` : ''})` : ''}` }
    : { name: 'hosted-mcp-reach', verdict: 'FAIL', detail: probe.error ?? `HTTP ${probe.status ?? '?'}` }
}

function serviceCheck(fix: boolean): DoctorCheck {
  const home = identityHome()
  if (alwaysOnOptedOut(home)) return { name: 'service', verdict: 'PASS', detail: 'disabled by the user (`daemon install` re-enables)' }
  if (fix && !listenerServiceCurrent()) {
    const repaired = ensureListenerService()
    if (!repaired.ok) return { name: 'service', verdict: 'FAIL', detail: `repair failed: ${repaired.detail ?? 'unknown error'}` }
  }
  if (!listenerServiceCurrent()) {
    return { name: 'service', verdict: 'WARN', detail: `service, durable daemon bundle or version marker is missing/stale — run \`${invocation()} doctor --fix\`` }
  }
  const state = alwaysOnState(home)
  return { name: 'service', verdict: state === 'down' ? 'FAIL' : 'PASS', detail: `${state}; service definition and daemon bundle match ${VERSION}` }
}

/**
 * Where runs work, and whether they can read it. The daemon passes the deny
 * rules for the identity home and ~/.claude.json on every run, so a workdir
 * inside either is a cwd the run cannot read (the pre-fix default was one).
 * The same env the service captured decides the path here, as it does for the
 * service check.
 */
export function workdirCheck(fix: boolean): DoctorCheck {
  const configDir = claudeConfigOverride()
  const workdir = resolveRunWorkdir(configDir)
  const denied = deniedAncestorOf(workdir, denyReadPathsFor(configDir))
  if (denied !== null) {
    return {
      name: 'run-workdir',
      verdict: 'WARN',
      detail: `${workdir} is inside ${denied}, which runs may not read — point AGENTCHAT_RUN_CWD outside it (or unset it for ${runWorkdirFor(configDir)}), then \`${invocation()} daemon install\``,
    }
  }
  const legacy = legacyRunWorkdirFor(configDir)
  if (!fs.existsSync(legacy)) return { name: 'run-workdir', verdict: 'PASS', detail: workdir }
  // Left behind by the old default. Empty: clutter, removed on --fix. Not
  // empty: a `work` run wrote there, and what to keep is the user's call.
  let empty = false
  try {
    empty = fs.readdirSync(legacy).length === 0
  } catch {
    /* unreadable: treat as not empty */
  }
  if (empty && fix) {
    try {
      fs.rmdirSync(legacy)
      return { name: 'run-workdir', verdict: 'PASS', detail: `${workdir}; removed the empty former default ${legacy}` }
    } catch {
      /* fall through to the warning */
    }
  }
  return {
    name: 'run-workdir',
    verdict: 'WARN',
    detail: empty
      ? `${workdir}; the former default ${legacy} is left behind inside the identity home — \`${invocation()} doctor --fix\` removes it`
      : `${workdir}; the former default ${legacy} is inside the identity home, where runs cannot read it — move anything you want to keep, then delete it`,
  }
}

function integrationCheck(): DoctorCheck {
  const home = identityHome()
  if (readCredentials(home) === null) return { name: 'integration', verdict: 'PASS', detail: 'no identity — the daemon idles by design' }
  const status = readIntegrationStatus(home)
  if (status === null) return { name: 'integration', verdict: 'WARN', detail: 'no status written yet — the daemon has not run, or is still starting' }
  const age = integrationStatusAge(status) ?? Number.POSITIVE_INFINITY
  if (age > 3 * 60_000) return { name: 'integration', verdict: 'FAIL', detail: `status last written ${Math.round(age / 60_000)} min ago — the daemon is not running` }
  if (status.socket === 'off') return { name: 'integration', verdict: 'PASS', detail: `${integrationDisabledBy() ?? INTEGRATION_ENV}=off — resident, holding no socket` }
  if (status.socket === 'ready') {
    const texts = status.texts?.source ?? 'none'
    return {
      name: 'integration',
      verdict: texts === 'none' ? 'WARN' : 'PASS',
      detail: `socket ready (acks on receipt), ${status.wakes} wake(s), ${status.runs_started} run(s) (${status.runs_ok} ok), texts ${texts === 'server' ? 'served' : texts === 'cache' ? 'from cache' : 'NOT fetched yet'}, profile ${status.profile}`,
    }
  }
  return { name: 'integration', verdict: 'WARN', detail: `socket ${status.socket}${status.last_error ? ` — ${status.last_error}` : ''}` }
}

const commands = createIdentityCommands(profile)

/** Persist a declined setup offer so the always-loaded CLAUDE.md does not nag. */
export function runNotNow(): number {
  const home = identityHome()
  recordOfferDeclined(home)
  try {
    writeAnchor(anchorFile(), renderDeclinedBlock({ invoke: invocation(), label: LABEL }))
  } catch (err) {
    console.error(`Recorded, but could not update ${path.basename(anchorFile())}: ${String(err)}`)
    return 1
  }
  console.log([`Noted — ${LABEL} will not ask about AgentChat again.`, `Changed your mind? ${invocation()} register --email <email> --handle <handle>`].join('\n'))
  return 0
}

/** `status` prints the shared lines, then this host's placement checks and the hosted-MCP probe (`extraStatus`, one texts fetch for both). */
export const { runRegister, runLogin, runRecover, runLogout, runStatus } = commands

export async function runDoctor(opts: DoctorOpts = {}): Promise<number> {
  const base = await commands.runDoctor(opts)
  const reach = await hostedMcpReachCheck()
  console.log(`${reach.verdict.padEnd(4)} ${reach.name}: ${reach.detail}`)
  return base !== 0 || reach.verdict === 'FAIL' ? 1 : 0
}

export type { RegisterOpts, DoctorOpts } from '@agentchatme/agent-core'
