import * as fs from 'node:fs'
import * as path from 'node:path'

export interface FakeClaude {
  binDir: string
  mcpState: string
  pluginState: string
}

/**
 * Install a deterministic Claude management CLI for integration tests.
 *
 * The production installer deliberately shells out to Claude's supported
 * `mcp` and `plugin` commands. Tests model those commands rather than reaching
 * into Claude's private config storage or mutating a developer's real setup.
 */
export function installFakeClaude(root: string, version = '2.1.220'): FakeClaude {
  const binDir = path.join(root, 'fake-bin')
  const configDir = path.join(root, '.claude')
  const mcpState = path.join(configDir, '.claude.json')
  const pluginState = path.join(configDir, 'fake-claude-plugin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(configDir, { recursive: true })

  const script = path.join(binDir, 'claude')
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const config = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude')",
      "const mcpState = path.join(config, '.claude.json')",
      "const pluginState = path.join(config, 'fake-claude-plugin')",
      'const args = process.argv.slice(2)',
      `if (args[0] === '--version') { console.log(${JSON.stringify(`${version} (Claude Code)`)}); process.exit(0) }`,
      "if (args[0] === 'mcp' && args[1] === 'get') {",
      "  if (!fs.existsSync(mcpState)) { console.error('No MCP server named \"agentchat\". Run `claude mcp add` to add one.'); process.exit(1) }",
      "  const doc = JSON.parse(fs.readFileSync(mcpState, 'utf8'))",
      "  const state = doc.mcpServers && doc.mcpServers.agentchat",
      "  if (!state) { console.error('No MCP server named \"agentchat\". Run `claude mcp add` to add one.'); process.exit(1) }",
      "  console.log('agentchat:')",
      "  console.log('  Scope: User')",
      "  console.log('  Command: ' + state.command)",
      "  console.log('  Args: ' + state.args.join(' '))",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'mcp' && args[1] === 'add') {",
      "  const separator = args.indexOf('--')",
      "  const command = separator >= 0 ? args.slice(separator + 1) : []",
      '  fs.mkdirSync(config, { recursive: true })',
      "  let doc = {}",
      "  try { doc = JSON.parse(fs.readFileSync(mcpState, 'utf8')) } catch {}",
      "  doc.mcpServers = { ...(doc.mcpServers || {}), agentchat: { type: 'stdio', command: command[0], args: command.slice(1), env: {} } }",
      "  fs.writeFileSync(mcpState, JSON.stringify(doc))",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'mcp' && args[1] === 'remove') {",
      "  try { const doc = JSON.parse(fs.readFileSync(mcpState, 'utf8')); if (doc.mcpServers) delete doc.mcpServers.agentchat; fs.writeFileSync(mcpState, JSON.stringify(doc)) } catch {}",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'plugin' && args[1] === 'list') {",
      "  console.log(fs.existsSync(pluginState) ? JSON.stringify([{ id: 'agentchat@agentchatme', scope: 'user' }]) : '[]')",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'plugin' && args[1] === 'uninstall') {",
      '  try { fs.unlinkSync(pluginState) } catch {}',
      '  process.exit(0)',
      '}',
      "console.error('unsupported fake claude command: ' + args.join(' '))",
      'process.exit(2)',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  return { binDir, mcpState, pluginState }
}
