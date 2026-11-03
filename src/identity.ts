import * as path from 'node:path'
import {
  alwaysOnOptedOut,
  alwaysOnState,
  createIdentityCommands,
  doorbellStatusAge,
  probeHostedMcp,
  readCredentials,
  readDoorbellStatus,
  recordOfferDeclined,
  renderAnchorBlock,
  renderDeclinedBlock,
  resolveIdentity,
  writeAnchor,
  type DoctorCheck,
  type DoctorOpts,
  type HostProfile,
} from '@agentchatme/agent-core'
import { identityHome, anchorFile, claudeConfigOverride, invocation, LABEL } from './host.js'
import { checkPlacement, placeAll, skillIsCurrent, unplaceIdentity, type PlacementIdentity } from './placement.js'
import { claudeIsLoggedIn, inspectClaudeRuntime } from './runner.js'
import { doorbellServiceCurrent, ensureDoorbellService } from './service.js'
import { VERSION } from './version.js'

// ─── This agent, described once ─────────────────────────────────────────────
//
// register / login / recover / status / logout / doctor are a contract with the
// AgentChat server, so the flows live in @agentchatme/agent-core and this file
// only says which agent they act on and how to PLACE for it: every time the key
// changes, the hosted MCP entry is re-registered with the new key, the manual is
// refreshed and the identity line rewritten.

export function currentPlacementIdentity(): PlacementIdentity | null {
  const identity = resolveIdentity(identityHome())
  if (identity === null || identity.handle === null) return null
  return { handle: identity.handle, apiKey: identity.apiKey, apiBase: identity.apiBase }
}

const profile: HostProfile = {
  label: LABEL,
  id: 'claude-code',
  home: identityHome,
  anchorFile,
  invocation,
  renderAnchor: renderAnchorBlock,
  isWired: skillIsCurrent,
  place: (handle, apiKey) => {
    const identity = resolveIdentity(identityHome())
    const steps = placeAll({ handle, apiKey, apiBase: identity?.apiBase ?? 'https://api.agentchat.me' })
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
  extraDoctorChecks: (opts): DoctorCheck[] => [...runtimeChecks(), ...placementChecks(opts.fix === true), serviceCheck(opts.fix === true), doorbellCheck()],
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

function placementChecks(fix: boolean): DoctorCheck[] {
  const identity = currentPlacementIdentity()
  if (fix) placeAll(identity)
  const checks: DoctorCheck[] = checkPlacement(identity)
    .filter((c) => c.name !== 'identity') // the shared doctor already reports the identity line
    .map((c) => ({ name: c.name === 'mcp' ? 'hosted-mcp' : c.name, verdict: c.ok ? 'PASS' : c.name === 'legacy' ? 'WARN' : identity ? 'FAIL' : 'WARN', detail: c.ok ? c.detail : `${c.detail} — run \`${invocation()}${fix ? '' : ' doctor --fix'}\`` }))
  return checks
}

/** One MCP `initialize` with the key: can this agent's tools be reached from here? */
export async function hostedMcpReachCheck(): Promise<DoctorCheck> {
  const identity = currentPlacementIdentity()
  if (identity === null) return { name: 'hosted-mcp-reach', verdict: 'WARN', detail: 'no identity — nothing to probe with' }
  const probe = await probeHostedMcp({ apiKey: identity.apiKey, apiBase: identity.apiBase, clientName: '@agentchatme/claude-code doctor', clientVersion: VERSION })
  return probe.ok
    ? { name: 'hosted-mcp-reach', verdict: 'PASS', detail: `initialize ok${probe.serverName ? ` (${probe.serverName}${probe.serverVersion ? ` ${probe.serverVersion}` : ''})` : ''}` }
    : { name: 'hosted-mcp-reach', verdict: 'FAIL', detail: probe.error ?? `HTTP ${probe.status ?? '?'}` }
}

function serviceCheck(fix: boolean): DoctorCheck {
  const home = identityHome()
  if (alwaysOnOptedOut(home)) return { name: 'service', verdict: 'PASS', detail: 'disabled by the user (`daemon install` re-enables)' }
  if (fix && !doorbellServiceCurrent()) {
    const repaired = ensureDoorbellService()
    if (!repaired.ok) return { name: 'service', verdict: 'FAIL', detail: `repair failed: ${repaired.detail ?? 'unknown error'}` }
  }
  if (!doorbellServiceCurrent()) {
    return { name: 'service', verdict: 'WARN', detail: `service, durable daemon bundle or version marker is missing/stale — run \`${invocation()} doctor --fix\`` }
  }
  const state = alwaysOnState(home)
  return { name: 'service', verdict: state === 'down' ? 'FAIL' : 'PASS', detail: `${state}; service definition and daemon bundle match ${VERSION}` }
}

function doorbellCheck(): DoctorCheck {
  const home = identityHome()
  if (readCredentials(home) === null) return { name: 'doorbell', verdict: 'PASS', detail: 'no identity — the daemon idles by design' }
  const status = readDoorbellStatus(home)
  if (status === null) return { name: 'doorbell', verdict: 'WARN', detail: 'no status written yet — the daemon has not run, or is still starting' }
  const age = doorbellStatusAge(status) ?? Number.POSITIVE_INFINITY
  if (age > 3 * 60_000) return { name: 'doorbell', verdict: 'FAIL', detail: `status last written ${Math.round(age / 60_000)} min ago — the daemon is not running` }
  if (status.socket === 'off') return { name: 'doorbell', verdict: 'PASS', detail: 'AGENTCHAT_DOORBELL=off — resident, holding no socket' }
  if (status.socket === 'ready') {
    return {
      name: 'doorbell',
      verdict: status.ack_negotiated === false ? 'WARN' : 'PASS',
      detail: `socket ready, ack ${status.ack_negotiated === null ? 'pending' : status.ack_negotiated ? 'negotiated' : 'NOT echoed'}, ${status.knocks} knock(s), ${status.runs_started} run(s) (${status.runs_ok} ok), profile ${status.profile}`,
    }
  }
  return { name: 'doorbell', verdict: 'WARN', detail: `socket ${status.socket}${status.last_error ? ` — ${status.last_error}` : ''}` }
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

export const { runRegister, runLogin, runRecover, runLogout } = commands

/** The shared status, then the placement checks and the hosted-MCP probe the brief asks status to show. */
export async function runStatus(opts: { json?: boolean }): Promise<number> {
  const code = await commands.runStatus(opts)
  if (opts.json) return code
  const identity = currentPlacementIdentity()
  const checks = checkPlacement(identity)
  console.log('Placement:')
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`)
  if (identity) {
    const reach = await hostedMcpReachCheck()
    console.log(`  ${reach.verdict === 'PASS' ? '✓' : '✗'} hosted MCP: ${reach.detail}`)
  }
  return code
}

export async function runDoctor(opts: DoctorOpts = {}): Promise<number> {
  const base = await commands.runDoctor(opts)
  const reach = await hostedMcpReachCheck()
  console.log(`${reach.verdict.padEnd(4)} ${reach.name}: ${reach.detail}`)
  return base !== 0 || reach.verdict === 'FAIL' ? 1 : 0
}

export type { RegisterOpts, DoctorOpts } from '@agentchatme/agent-core'
