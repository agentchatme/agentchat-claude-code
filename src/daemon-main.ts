import { parseArgs } from 'node:util'
import * as path from 'node:path'
import { log, resolveRunProfile, ensureInstallId, readRememberedHost, telemetryOff, type IntegrationClient } from '@agentchatme/agent-core'
import { runIntegration, type RunnerFactory, type RunnerIdentity } from '@agentchatme/agent-core/daemon'
import { anchorFile, CLIENT, claudeConfigOverride, identityHome, LABEL, resolveRunWorkdir, skillPath } from './host.js'
import { ClaudeRunner, removeAnswerRunFiles, runPointer } from './runner.js'

// ─── The integration daemon binary ──────────────────────────────────────────
//
// A SEPARATE bundle from the CLI, and that separation is load-bearing twice:
//
//   1. `ws` is CommonJS and reaches for `require` at runtime. Bundled into the
//      CLI's single-file ESM artifact it dies at startup. Keeping the socket
//      layer in its own binary means the CLI cannot regress that way.
//   2. A service should run a script whose entire job is to serve. The unit
//      names this file, so there is no subcommand to get wrong.
//
// The host is a compile-time fact here exactly as it is in the CLI: this file
// imports Claude Code's runner and Claude Code's home, and cannot name another
// coding agent. A run's prompt is the server's text for that run — the
// prompt for one conversation (one run per conversation that owes a reply),
// the invite prompt, or from an older server the wake instruction for the
// whole tray — fetched for the `claude-code` runtime
// (`GET /v1/texts?runtime=claude-code`, tool names already spelled
// `mcp__agentchat__agentchat_inbox` for a user-scope server named
// `agentchat`; code.claude.com/docs/en/mcp.md: `mcp__<server>__<tool>`),
// then one pointer to the skill — the one line only this package knows — in
// the profiles whose runs can open it (`runPointer`), naming the manual's
// address as the texts in hand announce it. Two placements follow the same
// texts from then on: the skill file follows the manual they announce
// (`manualPath`: synced at daemon start and whenever the texts change, and
// retried while it is not the announced version), and this agent's identity
// block in CLAUDE.md follows the served identity line (`anchorPath`: only
// this agent's own block, under the engine's rules; none is created, and one
// edited by hand or another agent's is left as it is).
//
// The runner is built per identity (a `RunnerFactory`): an answer run's own
// AgentChat-only tool config points at the API base of the agent the daemon
// serves, and a new sign-in builds a new runner. Building it is also when
// what an interrupted run left in the identity home is removed (an answer
// run's tool config holds a key; an answer or own run's identity line): this daemon holds the home's lock, and no run of
// the new runner has started yet; one of the previous runner's that is still
// stopping already read its files.

/**
 * What the daemon names itself with on every request and on the socket's
 * hello: this integration, the home's install id (none under
 * AGENTCHAT_TELEMETRY=off) and the runtime's version as a command last read
 * it (`readRememberedHost`: the daemon does not run `--version` before it
 * starts). The service runs a copy in the identity home, so no install
 * method is known here.
 */
function daemonClient(home: string): IntegrationClient {
  const installId = telemetryOff() ? null : ensureInstallId(home)
  const host = readRememberedHost(home)
  const { installMethod: _method, ...client } = CLIENT
  return { ...client, ...(installId !== null ? { installId } : {}), ...(host !== null ? { host } : {}) }
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let values: { home?: string | undefined; workdir?: string | undefined }
  try {
    ;({ values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { home: { type: 'string' }, workdir: { type: 'string' } },
    }))
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    console.error('Usage: agentchat-daemon [--home <dir>] [--workdir <dir>]')
    return 1
  }

  // `--home` is what the installed unit passes. Defaulting to this
  // integration's own home keeps a hand-run daemon honest.
  const home = values.home !== undefined ? path.resolve(values.home) : identityHome()
  const configDir = claudeConfigOverride()
  // The unit passes no `--workdir`: runs work in AGENTCHAT_RUN_CWD (captured at
  // install) or, by default, BESIDE the identity home — never inside it, since
  // every run's file tools are denied the identity home (runner.ts).
  const workdir = values.workdir !== undefined ? path.resolve(values.workdir) : resolveRunWorkdir(configDir)
  const profile = resolveRunProfile()
  const factory = {
    // The runner's own name and label (`ClaudeRunner.name`, `.label`), for status before any identity is known.
    name: 'claude',
    label: LABEL,
    create: (identity: RunnerIdentity) => {
      const { removed } = removeAnswerRunFiles(identity.home)
      if (removed.length > 0) log.info(`removed ${removed.length} file(s) an interrupted run left in ${identity.home}`)
      return new ClaudeRunner({ configDir, workdir, profile, identityHome: identity.home, apiBase: identity.apiBase, handle: identity.handle })
    },
  }
  // Assigned, not written in place: the pinned engine's RunnerFactory may not know `label` yet.
  const runner: RunnerFactory = factory

  return await runIntegration({
    home,
    workdir,
    profile,
    runner,
    client: daemonClient(home),
    manualPointer: runPointer(profile, skillPath()),
    manualPath: skillPath(),
    anchorPath: anchorFile(),
  })
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(String(err instanceof Error ? (err.stack ?? err.message) : err))
    process.exitCode = 1
  },
)
