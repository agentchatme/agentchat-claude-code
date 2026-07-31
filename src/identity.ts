import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  alwaysOnOptedOut,
  alwaysOnState,
  alwaysOnWanted,
  createIdentityCommands,
  readAlwaysOnInstalledVersion,
  readCredentials,
  recordOfferDeclined,
  renderDeclinedBlock,
  serviceDefinitionCurrent,
  serviceInstalled,
  writeAnchor,
  spawnCommandSync,
  type DoctorCheck,
  type HostProfile,
} from '@agentchatme/agent-core'
import {
  identityHome,
  anchorFile,
  claudeHome,
  invocation,
  LABEL,
  SERVICE_LABEL,
  serviceEnv,
} from './host.js'
import {
  inspectClaudeMcp,
  inspectCurrentProjectMcp,
  inspectClaudeRuntime,
  installClaude,
  isClaudeWired,
  manualPath,
  renderClaudeAgents,
  settingsPath,
  stableBundlePath,
  stableDaemonPath,
} from './wiring.js'
import { AGENTCHAT_MCP_PACKAGE, claudeIsLoggedIn } from './adapter.js'
import { ensureAlwaysOn } from './always-on.js'
import { VERSION } from './version.js'

// ─── This agent, described once ─────────────────────────────────────────────
//
// register / login / recover / status / logout / doctor are a contract with the
// AgentChat server — the pending-state machine, the error vocabulary, what a
// credential file holds — so the flows live in @agentchatme/agent-core and this
// file only says which agent they act on.
//
// It used to be ~510 lines here and ~515 in the Codex integration, 94%
// identical, and they had already drifted: this copy reported `"host": "codex"`
// in `status --json`.
//
// Sharing the flow does not weaken the guarantee. A profile can only describe
// its OWN agent — there is no field naming another host, and nothing here reads
// a `--platform`. The commands built from it can reach exactly one home.

const profile: HostProfile = {
  label: LABEL,
  id: 'claude-code',
  home: identityHome,
  anchorFile,
  invocation,
  renderAnchor: renderClaudeAgents,
  isWired: isClaudeWired,
  logoutHints: () => [
    `To remove the integration too, run \`${invocation()} uninstall\`.`,
  ],
  extraDoctorChecks: (opts): DoctorCheck[] => [
    ...runtimeChecks(),
    wiringCheck(opts.fix === true),
    projectMcpCheck(),
    alwaysOnCheck(opts.fix === true),
  ],
}

function concise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function runtimeChecks(): DoctorCheck[] {
  const npx = spawnCommandSync('npx', ['--version'], {
    encoding: 'utf-8',
    timeout: 5_000,
    windowsHide: true,
  })
  const mcpRunner: DoctorCheck = {
    name: 'mcp-runner',
    verdict: !npx.error && npx.status === 0 ? 'PASS' : 'FAIL',
    detail:
      !npx.error && npx.status === 0
        ? `npx ${concise(npx.stdout || npx.stderr)}`
        : npx.error?.message ?? `npx exited ${npx.status}`,
  }
  const version = inspectClaudeRuntime()
  if (!version.ok) {
    return [
      {
        name: 'claude-cli',
        verdict: 'FAIL',
        detail: version.detail,
      },
      { name: 'claude-auth', verdict: 'FAIL', detail: 'cannot check until the Claude CLI works' },
      mcpRunner,
    ]
  }
  const authenticated = claudeIsLoggedIn(claudeHome())
  return [
    {
      name: 'claude-cli',
      verdict: 'PASS',
      detail: concise(version.detail) || 'available',
    },
    {
      name: 'claude-auth',
      verdict: authenticated ? 'PASS' : 'FAIL',
      detail: authenticated
        ? 'Claude Code is authenticated for autonomous turns'
        : 'Claude Code is not authenticated',
    },
    mcpRunner,
  ]
}

function wiringCheck(fix: boolean): DoctorCheck {
  const current = (): boolean =>
    isClaudeWired() &&
    fs.existsSync(settingsPath()) &&
    fs.existsSync(stableBundlePath()) &&
    fs.existsSync(manualPath())

  if (fix && !current()) {
    try {
      const repaired = installClaude(readCredentials(identityHome())?.handle ?? null)
      if (!repaired.complete) {
        return {
          name: 'wiring',
          verdict: 'FAIL',
          detail: repaired.warnings.join('; ') || 'repair did not complete',
        }
      }
    } catch (err) {
      return { name: 'wiring', verdict: 'FAIL', detail: `repair failed: ${String(err)}` }
    }
  }

  if (current()) {
    return {
      name: 'wiring',
      verdict: 'PASS',
      detail: `current user MCP (${AGENTCHAT_MCP_PACKAGE}), four lifecycle hooks, bundle and manual`,
    }
  }

  const mcp = inspectClaudeMcp()
  return {
    name: 'wiring',
    verdict: 'FAIL',
    detail:
      `missing or stale direct integration (${mcp.detail}) — ` +
      `run \`${invocation()}${fix ? '' : ' doctor --fix'}\``,
  }
}

function projectMcpCheck(): DoctorCheck {
  const availability = inspectCurrentProjectMcp()
  return {
    name: 'project-mcp',
    verdict: availability.state === 'clear' ? 'PASS' : 'FAIL',
    detail: availability.detail,
  }
}

function alwaysOnCheck(fix: boolean): DoctorCheck {
  const home = identityHome()
  if (alwaysOnOptedOut(home)) {
    return { name: 'always-on', verdict: 'PASS', detail: 'disabled by the user' }
  }
  const service = {
    label: SERVICE_LABEL,
    home,
    entry: stableDaemonPath(),
    env: serviceEnv(),
  }
  const current = (): boolean =>
    alwaysOnWanted(home) &&
    fs.existsSync(service.entry) &&
    readAlwaysOnInstalledVersion(home) === VERSION &&
    serviceInstalled(service) &&
    serviceDefinitionCurrent(service)

  if (fix && isClaudeWired() && !current()) {
    const repaired = ensureAlwaysOn()
    if (!repaired.ok) {
      return {
        name: 'always-on',
        verdict: 'FAIL',
        detail: `repair failed: ${repaired.detail ?? 'unknown error'}`,
      }
    }
  }
  if (!current()) {
    return {
      name: 'always-on',
      verdict: isClaudeWired() ? 'FAIL' : 'WARN',
      detail: `service, durable bundle or version marker is missing/stale — run \`${invocation()} doctor --fix\``,
    }
  }
  const state = alwaysOnState(home)
  return {
    name: 'always-on',
    verdict: state === 'down' ? 'FAIL' : 'PASS',
    detail: `${state}; service definition and daemon bundle match ${VERSION}`,
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
  console.log(
    [
      `Noted — ${LABEL} will not ask about AgentChat again.`,
      `Changed your mind? ${invocation()} register --email <email> --handle <handle>`,
    ].join('\n'),
  )
  return 0
}

export const { runRegister, runLogin, runRecover, runStatus, runLogout, runDoctor } = commands

export type { RegisterOpts, DoctorOpts } from '@agentchatme/agent-core'
