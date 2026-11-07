import { parseArgs } from 'node:util'
import * as path from 'node:path'
import { manualPointer, resolveRunProfile } from '@agentchatme/agent-core'
import { runIntegration } from '@agentchatme/agent-core/daemon'
import { CLIENT, claudeConfigOverride, identityHome, resolveRunWorkdir, skillPath } from './host.js'
import { ClaudeRunner } from './runner.js'

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
// coding agent. The run prompt is the server's wake instruction, fetched for
// the `claude-code` runtime (`GET /v1/texts?runtime=claude-code`, tool names
// already spelled `mcp__agentchat__agentchat_inbox` for a user-scope server
// named `agentchat`; code.claude.com/docs/en/mcp.md: `mcp__<server>__<tool>`),
// then one pointer to the skill — the one line only this package knows. The
// skill file follows the manual the same texts announce (`manualPath`): the
// daemon downloads a new version when one is announced, on the texts' cadence.

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

  return await runIntegration({
    home,
    workdir,
    profile,
    runner: new ClaudeRunner({ configDir, workdir, profile }),
    client: CLIENT,
    manualPointer: manualPointer(`at ${skillPath()}`),
    manualPath: skillPath(),
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
