#!/usr/bin/env node
// Copies the built bundles into the plugin:
//   dist/index.js       → plugin/bin/agentchat              (CLI + hooks)
//   dist/daemon-main.js → plugin/bin/agentchat-daemon.mjs   (always-on daemon)
//
// These copies are COMMITTED, unlike every other dist artifact in the org: a
// Claude Code plugin is installed by git-cloning this repo, with no install
// step, so the hooks must find a runnable file already present. The CLI is
// extensionless and executable so a PATH exposure of plugin/bin gives the
// literal `agentchat` command; hooks invoke it via `node` + absolute path
// regardless. The daemon keeps its `.mjs` extension — nothing execs it by bare
// name, and the extension makes it obvious it is not the front door.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Normalise the bundler's source-path annotations before committing. esbuild
// writes the RESOLVED path of each input, so a local symlinked engine
// (`../agentchat-agent-core`) and CI's sibling checkout (`.agent-core`)
// produce byte-different bundles from identical source — which would make the
// drift check fail on every push for no real reason. Canonicalising keeps the
// check meaningful: it then fails only when the CODE actually changed.
//
// The whole engine prefix is rewritten, not just its `dist/`. The daemon also
// inlines `ws` from the engine's own node_modules
// (`<engine>/node_modules/.pnpm/ws@x/...`), and normalising only `dist/` left
// those paths host-specific — which broke the drift check on the first push
// that bundled a socket.
const normalise = (text) =>
  text
    .replaceAll('../agentchat-agent-core/', '@agentchatme/agent-core/')
    .replaceAll('.agent-core/', '@agentchatme/agent-core/')

// [built file, destination inside the plugin]
const ARTIFACTS = [
  ['index.js', 'agentchat'],
  ['daemon-main.js', 'agentchat-daemon.mjs'],
]

for (const [builtName, destName] of ARTIFACTS) {
  const bundle = path.join(root, 'dist', builtName)
  if (!fs.existsSync(bundle)) {
    console.error(`stamp: dist/${builtName} missing — run \`pnpm build:cli\` first`)
    process.exit(1)
  }
  const dest = path.join(root, 'plugin', 'bin', destName)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, normalise(fs.readFileSync(bundle, 'utf-8')))
  fs.chmodSync(dest, 0o755)
  console.log(`stamp: plugin/bin/${destName}`)
}
