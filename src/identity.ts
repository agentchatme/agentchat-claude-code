import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  alwaysOnOptedOut,
  agentLockDir,
  alwaysOnState,
  createIdentityCommands,
  DEFAULT_API_BASE,
  fetchServedTexts,
  integrationDisabledBy,
  INTEGRATION_ENV,
  integrationStatusAge,
  isRunProfile,
  probeHostedMcp,
  readCredentials,
  readIntegrationStatus,
  recordOfferDeclined,
  renderAnchorBlock,
  renderDeclinedBlock,
  resolveIdentity,
  resolveRunProfile,
  runProfileWarning,
  workdirExposesHome,
  writeAnchor,
  type DoctorCheck,
  type DoctorContext,
  type DoctorOpts,
  type HostProfile,
  type IntegrationUnservable,
  type RunProfile,
  type ServedManual,
  type StatusContext,
} from '@agentchatme/agent-core'
import { claudeAnswerFallbackWorkdir, inexpressibleDenyPaths } from '@agentchatme/agent-core/presets'
import { CLIENT, identityHome, anchorFile, claudeConfigOverride, invocation, LABEL, legacyRunWorkdirFor, resolveRunWorkdir, runWorkdirFor } from './host.js'
import { checkPlacement, placeAll, placementMark, skillPresent, unplaceIdentity, type PlacementIdentity } from './placement.js'
import { ClaudeRunner, claudeSignIn, deniedAncestorOf, denyReadPathsFor, inspectClaudeRuntime, profileNote } from './runner.js'
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
  extraDoctorChecks: async (ctx: DoctorContext): Promise<DoctorCheck[]> => {
    const runtime = await runtimeChecks()
    return [
      ...runtime,
      ...(await placementChecks(ctx.fix === true, ctx, ctx.manual)),
      serviceCheck(ctx.fix === true),
      workdirCheck(ctx.fix === true),
      profileCheck(),
      // The runner's own gate needs a working, signed-in Claude Code first; the checks above say when it is not.
      ...(runtime.every((c) => c.verdict === 'PASS') ? [await preflightCheck()] : []),
      integrationCheck(),
      ...[leaseCheck()].filter((c): c is DoctorCheck => c !== null),
    ]
  },
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

async function runtimeChecks(): Promise<DoctorCheck[]> {
  const version = await inspectClaudeRuntime(claudeConfigOverride())
  if (!version.ok) {
    return [
      { name: 'claude-cli', verdict: 'FAIL', detail: version.detail },
      { name: 'claude-auth', verdict: 'FAIL', detail: 'cannot check until the Claude CLI works' },
    ]
  }
  // A check that did not answer (it hung and was killed) is said as that, not as signed out.
  const signIn = await claudeSignIn(claudeConfigOverride())
  return [
    { name: 'claude-cli', verdict: 'PASS', detail: concise(version.detail) || 'available' },
    {
      name: 'claude-auth',
      verdict: signIn.signedIn ? 'PASS' : 'FAIL',
      detail: signIn.signedIn
        ? 'Claude Code is signed in; headless runs can start'
        : signIn.unanswered !== null
          ? `cannot tell whether Claude Code is signed in: ${signIn.unanswered}`
          : 'Claude Code is not signed in — run `claude` once and sign in',
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
 * The profile and work folder runs use: the daemon's own, from its status file
 * (it records both), when it has written one; this shell's switches otherwise
 * (install, `daemon install` and `doctor --fix` write the service from them).
 * `differs` names what this shell would change on the next of those.
 */
function runSettings(): { profile: RunProfile; workdir: string; source: 'daemon' | 'shell'; differs: string | null } {
  const configDir = claudeConfigOverride()
  const shell = { profile: resolveRunProfile(), workdir: resolveRunWorkdir(configDir) }
  const status = readIntegrationStatus(identityHome())
  if (status === null || !isRunProfile(status.profile)) return { ...shell, source: 'shell', differs: null }
  const recorded = { profile: status.profile, workdir: status.workdir ?? shell.workdir }
  const changes = [
    recorded.profile !== shell.profile ? `profile ${shell.profile}` : null,
    path.resolve(recorded.workdir) !== shell.workdir ? `work folder ${shell.workdir}` : null,
  ].filter((c): c is string => c !== null)
  return { ...recorded, source: 'daemon', differs: changes.length > 0 ? changes.join(' and ') : null }
}

/** ` (the daemon's; … from this shell would set …)` when the daemon's settings are not this shell's. */
function settingsNote(settings: ReturnType<typeof runSettings>): string {
  return settings.differs !== null ? ` (the daemon's, from its status; install, \`daemon install\` or \`doctor --fix\` from this shell would set ${settings.differs})` : ''
}

/** The runner the daemon builds, for the settings it runs with (`runSettings`). */
function daemonRunner(settings: ReturnType<typeof runSettings> = runSettings()): ClaudeRunner {
  return new ClaudeRunner({
    configDir: claudeConfigOverride(),
    workdir: settings.workdir,
    profile: settings.profile,
    apiBase: resolveIdentity(identityHome())?.apiBase ?? DEFAULT_API_BASE,
  })
}

/**
 * What a run started by a peer's message may do. `answer`: the AgentChat tools
 * and reads inside its work folder, nothing else. `work` and `full` are the
 * operator's opt-in, said with the engine's own warning (`runProfileWarning`).
 */
export function profileCheck(): DoctorCheck {
  const settings = runSettings()
  const warning = runProfileWarning(settings.profile)
  if (warning !== null) return { name: 'run-profile', verdict: 'WARN', detail: `${settings.profile}: ${warning}${settingsNote(settings)} (AGENTCHAT_RUN_PROFILE; answer is the default)` }
  return {
    name: 'run-profile',
    verdict: settings.differs !== null ? 'WARN' : 'PASS',
    detail: `answer: the AgentChat tools and reads inside ${daemonRunner(settings).workdir()} only — no web, no shell, no other MCP server, no CLAUDE.md, memory or hooks${settingsNote(settings)}`,
  }
}

/**
 * The runner's own preflight: the gate the daemon applies before it holds the
 * socket, in its exact words, for the settings it runs with. An answer run, for
 * one, does not start while a settings file lists
 * `permissions.additionalDirectories` (Claude Code counts those as working
 * directories). Like the daemon, it creates the run's work folder (owner-only)
 * when there is none.
 */
export async function preflightCheck(): Promise<DoctorCheck> {
  const pre = await daemonRunner().preflight()
  return pre.ok
    ? { name: 'run-preflight', verdict: 'PASS', detail: 'the daemon can start a run (the runner\'s preflight passes)' }
    : { name: 'run-preflight', verdict: 'FAIL', detail: `no run starts: ${pre.detail ?? 'the runner\'s preflight failed'}` }
}

/**
 * Where runs work, and whether they can read it. The daemon passes the deny
 * rules for the identity home and ~/.claude.json on every run, so a workdir
 * inside either is a cwd the run cannot read (the pre-fix default was one),
 * and one that contains either is safe only where a rule can carry the path
 * (not on Windows, not with a comma or whitespace in it). A workdir that is the
 * home folder or contains it is no answer run's: those work in an empty folder
 * of their own, and `work`/`full` runs would see the whole home. The settings
 * are the daemon's own when it has recorded them (`runSettings`).
 */
export function workdirCheck(fix: boolean): DoctorCheck {
  const configDir = claudeConfigOverride()
  const settings = runSettings()
  const workdir = settings.workdir
  const note = settingsNote(settings)
  if (workdirExposesHome(workdir)) {
    return {
      name: 'run-workdir',
      verdict: 'WARN',
      detail: `${workdir}${note} is your home folder or contains it — ${
        settings.profile === 'answer'
          ? `answer runs work in ${claudeAnswerFallbackWorkdir(configDir)} instead`
          : "a run started by a peer's message there can see everything under it"
      }; point AGENTCHAT_RUN_CWD at a folder of its own (or unset it for ${runWorkdirFor(configDir)}), then \`${invocation()} daemon install\``,
    }
  }
  const denied = deniedAncestorOf(workdir, denyReadPathsFor(configDir))
  if (denied !== null) {
    return {
      name: 'run-workdir',
      verdict: 'WARN',
      detail: `${workdir}${note} is inside ${denied}, which runs may not read — point AGENTCHAT_RUN_CWD outside it (or unset it for ${runWorkdirFor(configDir)}), then \`${invocation()} daemon install\``,
    }
  }
  // The key store inside the work folder, where no deny rule can carry it: a run there can read the key.
  const uncarried = inexpressibleDenyPaths(denyReadPathsFor(configDir).filter((p) => deniedAncestorOf(p, [workdir]) !== null))
  if (uncarried.length > 0) {
    return {
      name: 'run-workdir',
      verdict: 'WARN',
      detail: `${workdir}${note} contains ${uncarried.join(' and ')}, where the key is, and no read-deny rule can carry ${uncarried.length === 1 ? 'it' : 'them'} here (Windows, or a comma or whitespace in the path): a run working there can read the key — point AGENTCHAT_RUN_CWD at a folder of its own (or unset it for ${runWorkdirFor(configDir)}), then \`${invocation()} daemon install\``,
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
  // Every daemon rewrites its status while it runs — one standing by or waiting to serve again too — so an old file is a daemon that is down.
  const age = integrationStatusAge(status) ?? Number.POSITIVE_INFINITY
  if (age > 3 * 60_000) return { name: 'integration', verdict: 'FAIL', detail: `status last written ${Math.round(age / 60_000)} min ago — the daemon is not running` }
  if (status.socket === 'off') return { name: 'integration', verdict: 'PASS', detail: `${integrationDisabledBy() ?? INTEGRATION_ENV}=off — resident, holding no socket` }
  // A home that cannot serve gave the agent up (no socket, no run): what it said and what clears it,
  // as the shared `runs` check above says it in full.
  const gaveUp = status.unservable ?? null
  if (gaveUp !== null) return { name: 'integration', verdict: 'FAIL', detail: gaveUpLine(gaveUp) }
  // One agent, one listener: another daemon (the CLI listener, say) serves this agent from its own home.
  const standby = status.standby ?? null
  if (standby !== null) {
    return {
      name: 'integration',
      verdict: 'WARN',
      detail: `standing by — ${standby.home ?? 'another identity home'}${standby.pid !== null ? ` (pid ${standby.pid})` : ''} serves this agent; this daemon holds no socket and starts no run while it does, and takes over when it stops`,
    }
  }
  if (status.socket === 'ready') {
    const texts = status.texts?.source ?? 'none'
    // The daemon's own recheck after runs that did not get done (the `runs` check above is its FAIL).
    const failing = status.runs_failing ?? null
    if (failing !== null) {
      return { name: 'integration', verdict: 'WARN', detail: `socket ready, but runs are failing: ${failing.reason} (since ${failing.since}, ${failing.runs_missed} run(s) missed)` }
    }
    return {
      name: 'integration',
      verdict: texts === 'none' ? 'WARN' : 'PASS',
      detail: `socket ready (acks on receipt), ${status.wakes} wake(s), ${status.runs_started} run(s) (${status.runs_ok} ok), texts ${texts === 'server' ? 'served' : texts === 'cache' ? 'from cache' : 'NOT fetched yet'}, profile ${status.profile}${profileNote(status.profile)}`,
    }
  }
  // Not serving for another reason, in the daemon's own words (not connecting yet, say).
  return { name: 'integration', verdict: 'WARN', detail: `socket ${status.socket}${status.last_error ? ` — ${status.last_error}` : ''}` }
}

/**
 * Why this home gave its agent up and what clears it (the engine's
 * `unservable`): a refused key until a sign-in the server accepts; runs failing
 * (given up only to a healthy listener that was waiting) until a runtime check
 * passes. Either way it takes the agent back whenever no other listener holds it.
 */
export function gaveUpLine(gaveUp: IntegrationUnservable): string {
  return gaveUp.reason === 'key_refused'
    ? `this home gave the agent up: the server refuses its key (${gaveUp.detail}); signing in again here (\`${invocation()} login\` or \`recover\`) clears this at once — or log out here if another home serves the agent; it looks again at ${gaveUp.retry_at}`
    : `this home gave the agent up to another listener that was waiting: ${gaveUp.detail} (since ${gaveUp.since}); a runtime check that passes clears this (next at ${gaveUp.retry_at}, every 60 s), and it takes the agent back whenever no other listener holds it`
}

/** Lock renewals that failed (the engine's `lease_errors`): a lock that cannot be renewed for 45 s is given up. Null when none did. */
function leaseCheck(): DoctorCheck | null {
  const errors = readIntegrationStatus(identityHome())?.lease_errors ?? null
  if (errors === null || errors.count === 0) return null
  return {
    name: 'locks',
    verdict: 'WARN',
    detail: `${errors.count} lock renewal(s) failed${errors.last ? ` (last: ${errors.last})` : ''}; a lock that cannot be renewed for 45 s is given up — check that ${identityHome()} and ${agentLockDir()} are there and writable`,
  }
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
