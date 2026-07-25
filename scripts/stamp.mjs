#!/usr/bin/env node
// Copies the built CLI bundle into the plugin as `plugin/bin/agentchat`.
//
// This copy is COMMITTED, unlike every other dist artifact in the org: a
// Claude Code plugin is installed by git-cloning this repo, with no install
// step, so the hooks must find a runnable file already present. Extensionless
// and executable so a PATH exposure of plugin/bin gives the literal
// `agentchat` command; hooks invoke it via `node` + absolute path regardless.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = path.join(root, 'dist', 'index.js')
if (!fs.existsSync(bundle)) {
  console.error('stamp: dist/index.js missing — run `pnpm build:cli` first')
  process.exit(1)
}
const dest = path.join(root, 'plugin', 'bin', 'agentchat')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.copyFileSync(bundle, dest)
fs.chmodSync(dest, 0o755)
console.log('stamp: plugin/bin/agentchat')
