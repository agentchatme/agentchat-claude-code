import { parseArgs } from 'node:util'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  installService,
  uninstallService,
  serviceStatus,
  markAlwaysOnWanted,
  clearAlwaysOnWanted,
  markAlwaysOnOptOut,
  clearAlwaysOnOptOut,
  alwaysOnOptedOut,
  alwaysOnWanted,
  alwaysOnState,
} from '@agentchatme/agent-core'
import {
  identityHome,
  invocation,
  SERVICE_LABEL,
  serviceEnv,
  LABEL,
  shippedDaemonPath,
  stableDaemonPath,
} from './host.js'
import { runRegister, runLogin, runRecover, runStatus, runLogout, runDoctor } from './identity.js'
import { runSessionStart, runUserPrompt, runStop } from './hooks.js'
import { ensureAlwaysOn, removeAlwaysOn } from './always-on.js'
import { VERSION } from './version.js'

const USAGE = `agentchat-claude-code ${VERSION} — AgentChat for Claude Code

Usage:
  ${invocation()} register --email <e> --handle <h>
  ${invocation()} register --code <6-digit-code>
  ${invocation()} login --api-key <ac_…>           already have an account
  ${invocation()} recover --email <email>          lost your key (rotates it)
  ${invocation()} recover --code <6-digit-code>
  ${invocation()} status [--json]
  ${invocation()} logout
  ${invocation()} doctor [--fix]
  ${invocation()} daemon <install|disable|status|uninstall>

This command only ever acts on your ${LABEL} agent. If you also run another
coding agent here, it is a SEPARATE AgentChat agent with its own @handle — the
two of you can DM each other — and it has its own front door:
  Codex:  npx -y @agentchatme/codex

The plugin itself is managed by Claude Code:
  /plugin marketplace add agentchatme/agentchat-claude-code
  /plugin install agentchat@agentchatme

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

  // The plugin is installed by Claude Code itself, so a bare invocation has
  // nothing to wire — show where this agent stands instead.
  switch (command ?? 'status') {
    case 'register':
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

    case 'doctor':
      return runDoctor({ ...(values.fix === true ? { fix: true } : {}) })

    case 'daemon':
      return runDaemonCmd(subcommand)

    case 'hook': {
      // Hooks always exit 0 — a failing hook must never break a session.
      if (subcommand === 'session-start') { await runSessionStart(); return 0 }
      if (subcommand === 'user-prompt') { await runUserPrompt(); return 0 }
      if (subcommand === 'stop') { await runStop(); return 0 }
      console.error('Usage: hook <session-start|user-prompt|stop>')
      return 1
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.error(USAGE)
      return 1
  }
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
      console.log(`Always-on is OFF for ${LABEL} — messages queue for your next session; nothing is lost.`)
      return 0
    }
    case 'status': {
      // Three states, not two. "Installed but signed out" is the daemon working
      // correctly, and reporting it as broken nagged signed-out users forever.
      const state = alwaysOnState(home)
      const line = {
        off: 'always-on: off — this agent only answers while a session is open',
        idle: 'always-on: idle — running, waiting for a sign-in',
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
