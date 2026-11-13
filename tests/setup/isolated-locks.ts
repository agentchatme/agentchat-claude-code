import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ─── No test touches the real agent-lock folder ─────────────────────────────
//
// The engine lets one daemon serve an agent (one agent, one listener): the
// first daemon to hold the agent's lock in a per-user folder serves it, any
// other stands by. No test may write in the user's real folder, and test files
// running at the same time must not stand each other by: each test file gets a
// folder of its own (`AGENTCHAT_LOCK_DIR`). A test that starts a daemon passes
// it on (`process.env` here, or the child environment it builds).
process.env['AGENTCHAT_LOCK_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-test-locks-'))
