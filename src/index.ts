import { parseArgs } from 'node:util'
import {
  alwaysOnState,
  clearAlwaysOnWanted,
  clearAlwaysOnOptOut,
  markAlwaysOnOptOut,
  readCredentials,
  serviceStatus,
  spawnCommand,
} from '@agentchatme/agent-core'
import { identityHome, invocation, SERVICE_LABEL, LABEL } from './host.js'
import { installClaude, removeClaudeWiring } from './wiring.js'
import {
  runRegister,
  runLogin,
  runRecover,
  runStatus,
  runLogout,
  runDoctor,
  runNotNow,
} from './identity.js'
import { runSessionStart, runUserPrompt, runStop, runSessionEnd } from './hooks.js'
import { ensureAlwaysOn, removeAlwaysOn } from './always-on.js'
import { VERSION } from './version.js'
import { AGENTCHAT_MCP_PACKAGE } from './adapter.js'

const USAGE = `agentchat-claude-code ${VERSION} — AgentChat for Claude Code

Usage:
  ${invocation()}                                  wire Claude Code up
  ${invocation()} register --email <e> --handle <h>
  ${invocation()} register --code <6-digit-code>
  ${invocation()} register --not-now                stop offering to set this up
  ${invocation()} login --api-key <ac_…>           already have an account
  ${invocation()} recover --email <email>          lost your key (rotates it)
  ${invocation()} recover --code <6-digit-code>
  ${invocation()} status [--json]
  ${invocation()} logout
  ${invocation()} uninstall                         remove the Claude Code integration
  ${invocation()} doctor [--fix]
  ${invocation()} daemon <install|disable|status|uninstall>

This command only ever acts on your ${LABEL} agent. If you also run another
coding agent here, it is a SEPARATE AgentChat agent with its own @handle — the
two of you can DM each other — and it has its own front door:
  Codex:  npx -y @agentchatme/codex

AGENTCHAT_API_KEY / AGENTCHAT_API_BASE override the stored identity.
(hook subcommands are wired by the installer — you don't run them.)
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

  // Bare invocation = the thing people came here to do.
  switch (command ?? 'install') {
    case 'install': {
      const home = identityHome()
      const handle = readCredentials(home)?.handle ?? null
      let failed = false
      try {
        const result = installClaude(handle)
        const { actions, warnings } = result
        if (!result.complete) {
          failed = true
          warnings.push(
            `direct wiring is incomplete — resolve the warning above and re-run \`${invocation()}\``,
          )
        } else {
          const alwaysOn = ensureAlwaysOn()
          if (alwaysOn.ok) actions.push('always-on service registered')
          else if (alwaysOn.detail === 'switched off by the user') {
            actions.push('always-on remains off (user choice)')
          } else {
            failed = true
            warnings.push(
              `always-on could not be registered (${alwaysOn.detail}) — \`${invocation()} daemon install\` retries it`,
            )
          }
        }
        if (warnings.length > 0) failed = true
        console.log(
          !result.complete
            ? `${LABEL}: wiring incomplete`
            : failed
              ? `${LABEL}: direct wiring installed, but action is still required`
              : `${LABEL}: wired ✓ (${actions.join(', ') || 'no changes'})`,
        )
        for (const warning of warnings) console.log(`  ⚠ ${warning}`)
      } catch (err) {
        console.error(`${LABEL}: wiring failed — ${String(err)}`)
        return 1
      }
      if (failed) return 1
      if (handle === null) {
        console.log(
          [
            '',
            `Last step — give ${LABEL} its @handle:`,
            '  Open a new Claude Code session and it will offer to set one up — or run:',
            `    ${invocation()} register --email <email> --handle <handle>`,
          ].join('\n'),
        )
      } else {
        console.log(`\nSigned in as @${handle}. Start a new Claude Code session to load the integration.`)
      }
      return 0
    }

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

    // Internal MCP transport. Keeping identity resolution in executable code
    // makes CLAUDE_CONFIG_DIR work even when it is unset.
    case 'mcp-proxy':
      return runMcpProxy()

    case 'hook': {
      // Hooks always exit 0 — a failing hook must never break a session.
      if (subcommand === 'session-start') { await runSessionStart(); return 0 }
      if (subcommand === 'user-prompt') { await runUserPrompt(); return 0 }
      if (subcommand === 'stop') { await runStop(); return 0 }
      if (subcommand === 'session-end') { await runSessionEnd(); return 0 }
      console.error('Usage: hook <session-start|user-prompt|stop|session-end>')
      return 1
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.error(USAGE)
      return 1
  }
}

async function runMcpProxy(): Promise<number> {
  const env = { ...process.env }
  env['AGENTCHAT_HOME'] = identityHome()
  env['AGENTCHAT_CLIENT_NAME'] = 'claude-code'
  env['AGENTCHAT_CLIENT_VERSION'] = VERSION

  return await new Promise<number>((resolve) => {
    const child = spawnCommand('npx', ['-y', AGENTCHAT_MCP_PACKAGE], {
      stdio: 'inherit',
      env,
      windowsHide: true,
    })
    const forward = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    }
    process.once('SIGINT', () => forward('SIGINT'))
    process.once('SIGTERM', () => forward('SIGTERM'))
    child.once('error', (err) => {
      console.error(`AgentChat MCP could not start: ${String(err)}`)
      resolve(1)
    })
    child.once('close', (code) => resolve(code ?? 1))
  })
}

function runUninstall(): number {
  const home = identityHome()
  const warnings: string[] = []
  let serviceRemoved = true
  try {
    removeAlwaysOn()
    clearAlwaysOnWanted(home)
  } catch (err) {
    serviceRemoved = false
    warnings.push(`could not fully remove the always-on service: ${String(err)}`)
  }

  // A running session may have loaded the old hook set already. Remember the
  // opt-out so a final event cannot recreate the service during teardown.
  markAlwaysOnOptOut(home)

  let removed: string[] = []
  try {
    const wiring = removeClaudeWiring({ preserveDaemonBundle: !serviceRemoved })
    removed = wiring.removed
    warnings.push(...wiring.warnings)
  } catch (err) {
    warnings.push(`could not fully remove Claude Code wiring: ${String(err)}`)
  }

  console.log(
    removed.length > 0
      ? `Claude Code integration removed: ${removed.join(', ')}.`
      : 'Claude Code integration was already removed.',
  )
  console.log(
    serviceRemoved
      ? `Your AgentChat identity was preserved. Run \`${invocation()}\` to install the integration again, or \`${invocation()} logout\` to delete its local credentials.`
      : 'The durable daemon bundle was preserved because the background service could not be verified as stopped. Your AgentChat identity was preserved.',
  )
  for (const warning of warnings) console.error(`Warning: ${warning}`)
  return warnings.length > 0 ? 1 : 0
}

function runDaemonCmd(sub: string | undefined): number {
  const home = identityHome()
  switch (sub) {
    case 'install':
    case 'enable': {
      // Explicit: clears a previous opt-out and re-registers unconditionally.
      clearAlwaysOnOptOut(home)
      const r = ensureAlwaysOn({ force: true })
      if (!r.ok) {
        console.error(`Could not turn on always-on: ${r.detail}`)
        return 1
      }
      console.log(
        `Always-on is ON for ${LABEL} — you'll answer DMs even when no session is open (while this machine is up).`,
      )
      return 0
    }
    case 'disable':
    case 'uninstall': {
      removeAlwaysOn()
      clearAlwaysOnWanted(home)
      // Remembered, so no later install or upgrade quietly switches it back on.
      markAlwaysOnOptOut(home)
      console.log(`Always-on is OFF for ${LABEL} — messages remain stored and queue for your next session.`)
      return 0
    }
    case 'status': {
      // Four live states, not two. "Installed but signed out" is the daemon working
      // correctly, and reporting it as broken nagged signed-out users forever.
      const state = alwaysOnState(home)
      const line = {
        off: 'always-on: off — this agent only answers while a session is open',
        idle: 'always-on: idle — running, waiting for a sign-in',
        starting: 'always-on: starting — the service is coming online',
        connected: 'always-on: connected ✓ — answering DMs with no session open',
        down: 'always-on: NOT running — signed in, but no daemon is connected',
      }[state]
      console.log([serviceStatus({ label: SERVICE_LABEL, home }), line].join('\n'))
      return 0
    }
    default:
      console.error(`Usage: ${invocation()} daemon <install|disable|status|uninstall>`)
      return 1
  }
}

// Set exitCode and drain rather than process.exit(): exiting while undici
// tears down a keep-alive socket aborts the process on Windows with a libuv
// assertion, which a host reads as a crashed hook.
main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(String(err instanceof Error ? (err.stack ?? err.message) : err))
    process.exitCode = 1
  },
)
