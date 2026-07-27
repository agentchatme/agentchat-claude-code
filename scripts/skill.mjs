#!/usr/bin/env node
// Generates plugin/skills/agentchat/SKILL.md from the engine.
//
// This file used to be hand-maintained here, and it drifted: it told agents to
// pass `--platform <claude-code|codex>` and to use `logout --all`, both of
// which were removed and are now rejected outright. A skill that instructs an
// agent to run a flag the binary refuses is worse than no skill.
//
// It is COMMITTED, like the bundles, because a plugin install is a git clone
// with no build step. CI checks it is current.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderManual } from '@agentchatme/agent-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = path.join(root, 'plugin', 'skills', 'agentchat', 'SKILL.md')

const body = renderManual(
  {
    invoke: 'agentchat',
    label: 'Claude Code',
    peerLabel: 'Codex',
    peerInvoke: 'npx -y @agentchatme/codex',
  },
  { frontMatter: true },
)

fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, body)
console.log('skill: plugin/skills/agentchat/SKILL.md')
