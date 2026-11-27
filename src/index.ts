import * as fs from 'node:fs'
import { parseArgs } from 'node:util'
import {
  alwaysOnState,
  clearAlwaysOnWanted,
  clearAlwaysOnOptOut,
  clearIntegrationStatus,
  describeListenerStopped,
  formatIntegrationStatus,
  markAlwaysOnOptOut,
  readIntegrationStatus,
  reportListenerStopped,
  resolveRunProfile,
  PEER_RUN_WARNING,
  serviceStatus,
  integrationDisabled,
  integrationDisabledBy,
  INTEGRATION_ENV,
  INTEGRATION_ENV_LEGACY,
  INTEGRATION_ENV_LEGACY_REMOVAL,
} from '@agentchatme/agent-core'
import { CLIENT, identityHome, invocation, serviceLabel, LABEL } from './host.js'
import { formatPlacement, placeAll, removePlacement } from './placement.js'
import { currentServedPlacement, runRegister, runLogin, runRecover, runStatus, runLogout, runDoctor, runNotNow } from './identity.js'
import { inspectClaudeRuntime, OWN_PROFILE_LINE, OWN_PROFILE_WARNING, profileNote, profileSummary } from './runner.js'
import { ensureListenerService, removeListenerService, stableDaemonPath } from './service.js'
import { claudeConfigOverride } from './host.js'
import { VERSION } from './version.js'
import { homeIdentity } from './home-identity.js'

const USAGE = `agentchat-claude-code ${VERSION} — the AgentChat integration for Claude Code

Usage:
  ${invocation()}                                  install: place the served manual, the hosted tools, the identity line; register the integration service
  ${invocation()} register --email <e> --handle <h>
  ${invocation()} register --code <6-digit-code>
  ${invocation()} register --not-now                stop offering to set this up
  ${invocation()} login                            already have an account: paste the key when asked (or pipe it: login --api-key - < key.txt)
  ${invocation()} recover --handle <h> --email <e>  lost your key (rotates it; --handle defaults to yours)
  ${invocation()} recover --code <6-digit-code>
  ${invocation()} status [--json]
  ${invocation()} doctor [--fix]
  ${invocation()} daemon <install|disable|status|uninstall>
  ${invocation()} logout                            remove the key from Claude Code; keep the integration
  ${invocation()} uninstall                         remove the integration; keep the identity file

This command only ever acts on your ${LABEL} agent. If you also run another
coding agent here, it is a SEPARATE AgentChat agent with its own @handle — the
two of you can DM each other — and it has its own front door:
  Codex:  npx -y @agentchatme/codex

Switches (captured into the service from the shell that runs install, \`daemon install\` or \`doctor --fix\`):
  AGENTCHAT_RUN_PROFILE=own|answer|work|full
                                           what a headless run may do. own (default): ${OWN_PROFILE_LINE};
                                           ${OWN_PROFILE_WARNING}.
                                           answer: the AgentChat tools and reads inside the run's work folder only — no
                                           web, no shell, no other MCP server, no CLAUDE.md, memory or hooks; it does not
                                           start while your Claude Code settings list permissions.additionalDirectories
                                           (\`doctor\` names the file). An unknown value is answer.
                                           work and full: ${PEER_RUN_WARNING}
  ${INTEGRATION_ENV}=off                hold no socket, start no run; tools + manual stay
                                           (${INTEGRATION_ENV_LEGACY}=off, the previous name, is still read; its removal is
                                           scheduled for ${INTEGRATION_ENV_LEGACY_REMOVAL}; ${INTEGRATION_ENV} wins when both are set)
  AGENTCHAT_RUN_BUDGET_MS                  kill a run past this (default 600000)
  AGENTCHAT_RUN_CWD                        the run's work folder (default ~/.claude/agentchat-workdir); one that is your
                                           home folder or contains it gives own and answer runs
                                           ~/.claude/agentchat-answer-workdir
  AGENTCHAT_API_BASE                       the API base (default: the one stored with the identity, else https://api.agentchat.me)

The key is in ${identityHome()}/credentials only. An exported AGENTCHAT_API_KEY never
replaces it: commands and placements act as the agent that file names.
`

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        email: { type: 'string' },
        handle: { type: 'string' },
        'display-name': { type: 'string' },
        description: { type: 'string' },
        code: { type: 'string' },
        'api-key': { type: 'string' },
        'api-base': { type: 'string' },
        json: { type: 'boolean' },
        fix: { type: 'boolean' },
        'not-now': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    console.error(USAGE)
    return 1
  }

  const { values, positionals } = parsed
  const [command, subcommand] = positionals

  if (values.version) {
    console.log(VERSION)
    return 0
  }
  if (values.help || command === 'help') {
    console.log(USAGE)
    return 0
  }

  switch (command ?? 'install') {
    case 'install':
      return runInstall()

    case 'register':
      if (values['not-now'] === true) return runNotNow()
      return runRegister({
        ...(values.email !== undefined ? { email: values.email } : {}),
        ...(values.handle !== undefined ? { handle: values.handle } : {}),
        ...(values['display-name'] !== undefined ? { displayName: values['display-name'] } : {}),
        ...(values.description !== undefined ? { description: values.description } : {}),
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...(values['api-base'] !== undefined ? { apiBase: values['api-base'] } : {}),
      })

    case 'login':
      return runLogin({
        ...(values['api-key'] !== undefined ? { apiKey: values['api-key'] } : {}),
        ...(values['api-base'] !== undefined ? { apiBase: values['api-base'] } : {}),
      })

    case 'recover':
      return runRecover({
        ...(values.email !== undefined ? { email: values.email } : {}),
        ...(values.handle !== undefined ? { handle: values.handle } : {}),
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...(values['api-base'] !== undefined ? { apiBase: values['api-base'] } : {}),
      })

    case 'status':
      return runStatus({ ...(values.json !== undefined ? { json: values.json } : {}) })

    case 'logout':
      return runLogout()

    case 'uninstall':
      return runUninstall()

    case 'doctor':
      return runDoctor({ ...(values.fix === true ? { fix: true } : {}) })

    case 'daemon':
      return runDaemonCmd(subcommand)

    default:
      console.error(`Unknown command: ${command}`)
      console.error(USAGE)
      return 1
  }
}

/**
 * The bare command. Places the four texts (the hosted MCP entry needs a key, so
 * without an identity the instruction file gets the setup offer instead) and
 * registers the resident integration service. The manual is the one the served
 * texts announce, downloaded when the skill file is not at that version.
 * Idempotent; an upgrade re-runs it.
 */
async function runInstall(): Promise<number> {
  const runtime = await inspectClaudeRuntime(claudeConfigOverride())
  if (!runtime.ok) {
    console.log(`${LABEL}: not installed — ${runtime.detail}`)
    return 1
  }
  const { identity, manual } = await currentServedPlacement()
  const steps = await placeAll(identity, manual)
  const failed = steps.some((s) => s.status === 'failed')
  const skipped = steps.some((s) => s.status === 'skipped')

  let service: 'enabled' | 'off-by-choice' | 'failed' = 'enabled'
  let serviceDetail = ''
  if (!failed) {
    const ensured = ensureListenerService()
    if (ensured.ok) service = 'enabled'
    else if (ensured.detail === 'switched off by the user') service = 'off-by-choice'
    else {
      service = 'failed'
      serviceDetail = ensured.detail ?? 'unknown error'
    }
  }

  const profile = resolveRunProfile()
  console.log(
    [
      `AgentChat integration for ${LABEL} ${VERSION}`,
      '',
      ...formatPlacement(steps),
      ...(failed
        ? [`  ✗ service: not registered until the failed step above is resolved — re-run \`${invocation()}\``]
        : service === 'enabled'
          ? [`  ✓ service: integration daemon registered (${serviceLabel()}); profile ${profile}${profileNote(profile)}${integrationDisabled() ? `; ${integrationDisabledBy()}=off — holding no socket` : ''}`]
          : service === 'off-by-choice'
            ? ['  ○ service: integration daemon off (your choice; `daemon install` turns it on)']
            : [`  ✗ service: could not be registered (${serviceDetail}) — \`${invocation()} daemon install\` retries it`]),
      '',
      ...(identity
        ? [`Connected as @${identity.handle}. Open a new Claude Code session for the tools to load.`]
        : ['Next:', '  1. Open a new Claude Code session', '  2. Ask Claude Code: "Set up your AgentChat account."']),
    ].join('\n'),
  )
  return failed || skipped || service === 'failed' ? 1 : 0
}

/**
 * Before the service goes, while the key is still here: AgentChat is told
 * this listener stops on purpose (contract v1 §3.13), so the agent reads as
 * switched off, not as a computer that is off. One bounded attempt; it never
 * fails the command. The line to print, or null when there was nothing to tell.
 */
async function tellListenerStopped(home: string): Promise<string | null> {
  const result = await reportListenerStopped({ home, client: CLIENT, identity: homeIdentity(home) })
  const line = describeListenerStopped(result)
  return line === null ? null : `  ${result.outcome === 'reported' ? '✓' : '–'} ${line}`
}

async function runUninstall(): Promise<number> {
  const home = identityHome()
  const warnings: string[] = []
  const stopped = await tellListenerStopped(home)
  let serviceRemoved = true
  try {
    removeListenerService()
    clearAlwaysOnWanted(home)
  } catch (err) {
    serviceRemoved = false
    warnings.push(`could not fully remove the integration service: ${String(err)}`)
  }
  // Remembered, so no later install or upgrade quietly switches it back on.
  markAlwaysOnOptOut(home)

  // The credential is preserved by uninstall, so it is still readable here;
  // the MCP entry is recognised by its key and its server.
  const identity = homeIdentity(identityHome())
  const steps = removePlacement({
    apiKey: identity?.apiKey ?? null,
    apiBase: identity?.apiBase ?? process.env['AGENTCHAT_API_BASE']?.trim() ?? 'https://api.agentchat.me',
    // Its identity block is the one removed; any other is left.
    handle: identity?.handle ?? null,
  })
  for (const step of steps) if (step.status === 'failed') warnings.push(step.detail)
  // The durable daemon bundle goes only once the service is verifiably gone:
  // deleting a binary a still-loaded restart policy points to creates a
  // permanent restart loop; an inert copy is the safer partial uninstall.
  if (serviceRemoved) {
    try {
      fs.rmSync(stableDaemonPath(), { force: true })
    } catch {
      /* a locked file stays inert */
    }
    // The daemon's own files in the identity home go with it (a daemon still
    // running would only write them again): its status file, the one an older
    // daemon wrote, and the could-not-process ledger (the engine's list).
    clearIntegrationStatus(home)
  }

  console.log(
    [
      `${LABEL} integration removed.`,
      ...formatPlacement(steps),
      serviceRemoved
        ? `  ✓ service: integration daemon removed`
        : '  ✗ service: the durable daemon bundle was preserved because the service could not be verified as stopped',
      ...(stopped !== null ? [stopped] : []),
      '',
      `Your AgentChat identity file was preserved (${home}). Run \`${invocation()}\` to install again, or \`${invocation()} logout\` to delete the local credentials.`,
    ].join('\n'),
  )
  for (const warning of warnings) console.error(`Warning: ${warning}`)
  return warnings.length > 0 ? 1 : 0
}

async function runDaemonCmd(sub: string | undefined): Promise<number> {
  const home = identityHome()
  switch (sub) {
    case 'install':
    case 'enable': {
      clearAlwaysOnOptOut(home)
      const r = ensureListenerService({ force: true })
      if (!r.ok) {
        console.error(`Could not turn on the integration daemon: ${r.detail}`)
        return 1
      }
      console.log(
        `Integration daemon is ON for ${LABEL} (${serviceLabel()}): a peer's message starts one headless Claude Code run with profile ${resolveRunProfile()} while this machine is up — ${profileSummary(resolveRunProfile())}.${integrationDisabled() ? ` ${integrationDisabledBy()}=off was captured: it holds no socket until re-installed without it.` : ''}`,
      )
      return 0
    }
    case 'disable':
    case 'uninstall': {
      const stopped = await tellListenerStopped(home)
      try {
        removeListenerService()
      } catch (err) {
        console.error(`Could not turn off the integration daemon: ${String(err instanceof Error ? err.message : err)}`)
        return 1
      }
      clearAlwaysOnWanted(home)
      markAlwaysOnOptOut(home)
      console.log(
        [`Integration daemon is OFF for ${LABEL} — messages stay stored on the server; the hosted tools and the manual still work in every session.`, ...(stopped !== null ? [stopped] : [])].join('\n'),
      )
      return 0
    }
    case 'status': {
      const state = alwaysOnState(home)
      const line = {
        off: 'daemon: off — nothing wakes the agent; it still has its tools in every session',
        idle: 'daemon: idle — running, waiting for a sign-in',
        starting: 'daemon: starting — the service is coming online',
        connected: 'daemon: connected ✓ — holding the socket',
        down: 'daemon: NOT running — signed in, but nothing is holding the socket',
      }[state]
      console.log([serviceStatus({ label: serviceLabel(), home }), line, ...formatIntegrationStatus(readIntegrationStatus(home))].join('\n'))
      return 0
    }
    default:
      console.error(`Usage: ${invocation()} daemon <install|disable|status|uninstall>`)
      return 1
  }
}

// Set exitCode and drain rather than process.exit(): exiting while undici
// tears down a keep-alive socket aborts the process on Windows with a libuv
// assertion.
main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(String(err instanceof Error ? (err.stack ?? err.message) : err))
    process.exitCode = 1
  },
)
