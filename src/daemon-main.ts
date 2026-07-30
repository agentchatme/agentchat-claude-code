import { parseArgs } from 'node:util'
import * as path from 'node:path'
import { runDaemon } from '@agentchatme/agent-core/daemon'
import { ClaudeAdapter } from './adapter.js'
import { claudeHome, identityHome } from './host.js'

// ─── The always-on daemon binary ────────────────────────────────────────────
//
// A SEPARATE bundle from the CLI, and that separation is load-bearing twice
// over:
//
//   1. `ws` is CommonJS and reaches for `require` at runtime. Bundled into the
//      CLI's single-file ESM artifact it dies at startup with "Dynamic require
//      of events is not supported" — taking down the CLI and lifecycle hooks
//      with it. Keeping the socket layer in its own binary means the CLI
//      cannot regress that way.
//   2. A service should run a script whose entire job is to serve. The unit
//      names this file, so there is no subcommand to get wrong and no chance of
//      pointing a service at something that exits immediately.
//
// The host is a compile-time fact here exactly as it is in the CLI: this file
// imports Claude Code's adapter and Claude Code's home, and cannot name another
// coding agent.

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
  // integration's own home keeps a hand-run daemon honest rather than making it
  // guess.
  const home = values.home !== undefined ? path.resolve(values.home) : identityHome()
  const workdir = values.workdir !== undefined ? path.resolve(values.workdir) : path.join(home, 'daemon-workdir')

  return await runDaemon({
    home,
    workdir,
    adapter: new ClaudeAdapter(claudeHome(), home, workdir),
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
