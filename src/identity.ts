import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  alwaysOnOptedOut,
  alwaysOnState,
  alwaysOnWanted,
  createIdentityCommands,
  readAlwaysOnInstalledVersion,
  renderAnchorBlock,
  serviceDefinitionCurrent,
  serviceInstalled,
  type DoctorCheck,
  type HostProfile,
} from '@agentchatme/agent-core'
import {
  identityHome,
  anchorFile,
  claudeHome,
  invocation,
  LABEL,
  pluginMcpConfigPath,
  SERVICE_LABEL,
  serviceEnv,
  shippedDaemonPath,
  stableDaemonPath,
} from './host.js'
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
  renderAnchor: renderAnchorBlock,
  // Nothing to un-wire: Claude Code installs and removes the plugin itself, so
  // logout only drops this agent's credentials and its anchor.
  logoutHints: () => [
    `To remove the integration too, first run \`${invocation()} uninstall\`, then: /plugin uninstall agentchat@agentchatme`,
  ],
  extraDoctorChecks: (opts): DoctorCheck[] => [
    ...runtimeChecks(),
    pluginMcpCheck(),
    alwaysOnCheck(opts.fix === true),
  ],
}

function concise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function runtimeChecks(): DoctorCheck[] {
  const npx = spawnSync('npx', ['--version'], {
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
  const version = spawnSync('claude', ['--version'], {
    encoding: 'utf-8',
    timeout: 5_000,
    windowsHide: true,
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome() },
  })
  if (version.error || version.status !== 0) {
    return [
      {
        name: 'claude-cli',
        verdict: 'FAIL',
        detail: version.error ? `unavailable: ${version.error.message}` : `exited ${version.status}`,
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
      detail: concise(version.stdout || version.stderr) || 'available',
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

function pluginMcpCheck(): DoctorCheck {
  try {
    const config = JSON.parse(fs.readFileSync(pluginMcpConfigPath(), 'utf-8')) as {
      mcpServers?: { agentchat?: { command?: unknown; args?: unknown } }
    }
    const server = config.mcpServers?.agentchat
    const args = Array.isArray(server?.args) ? server.args : []
    const current =
      server?.command === 'node' &&
      args.includes('${CLAUDE_PLUGIN_ROOT}/bin/agentchat') &&
      args.includes('mcp-proxy')
    return current
      ? {
          name: 'plugin-mcp',
          verdict: 'PASS',
          detail: `plugin proxy launches ${AGENTCHAT_MCP_PACKAGE} with this agent's config directory`,
        }
      : {
          name: 'plugin-mcp',
          verdict: 'FAIL',
          detail: 'plugin MCP declaration is missing or stale; update/reinstall the plugin',
        }
  } catch (err) {
    return {
      name: 'plugin-mcp',
      verdict: 'FAIL',
      detail: `cannot read ${pluginMcpConfigPath()}: ${String(err)}`,
    }
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
    fs.existsSync(shippedDaemonPath()) &&
    fs.existsSync(service.entry) &&
    readAlwaysOnInstalledVersion(home) === VERSION &&
    serviceInstalled(service) &&
    serviceDefinitionCurrent(service)

  if (fix && !current()) {
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
      verdict: 'FAIL',
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

export const { runRegister, runLogin, runRecover, runStatus, runLogout, runDoctor } =
  createIdentityCommands(profile)

export type { RegisterOpts, DoctorOpts } from '@agentchatme/agent-core'
