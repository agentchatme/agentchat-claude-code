import { parseArgs } from 'node:util'
import * as path from 'node:path'
import { buildDoorbellPrompts, manualPointer, mcpToolNamer, resolveRunProfile } from '@agentchatme/agent-core'
import { runDoorbell } from '@agentchatme/agent-core/daemon'
import { claudeConfigOverride, identityHome, MCP_SERVER_NAME, skillPath } from './host.js'
import { ClaudeRunner } from './runner.js'

// ─── The doorbell daemon binary ─────────────────────────────────────────────
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
// coding agent. The run prompt is the server's wake instruction with Claude
// Code's spelling of the hosted tools — `mcp__agentchat__agentchat_inbox` for a
// user-scope server named `agentchat` (code.claude.com/docs/en/mcp.md:
// `mcp__<server>__<tool>`) — then one pointer to the bundled skill.

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
  const runCwd = process.env['AGENTCHAT_RUN_CWD']?.trim()
  const workdir =
    values.workdir !== undefined
      ? path.resolve(values.workdir)
      : runCwd !== undefined && runCwd.length > 0
        ? path.resolve(runCwd)
        : path.join(home, 'daemon-workdir')
  const profile = resolveRunProfile()

  return await runDoorbell({
    home,
    workdir,
    profile,
    runner: new ClaudeRunner({ configDir: claudeConfigOverride(), workdir, profile }),
    prompts: buildDoorbellPrompts({
      toolName: mcpToolNamer(MCP_SERVER_NAME),
      manualPointer: manualPointer(`at ${skillPath()}`),
    }),
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
