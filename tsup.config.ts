import { defineConfig } from 'tsup'

// A single self-contained ESM file: the plugin is git-cloned with no install
// step, so the hooks must be able to run `node plugin/bin/agentchat` directly.
// `splitting:false` is load-bearing — a split bundle breaks that.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: true,
  splitting: false,
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  noExternal: ['@agentchatme/agent-core', 'zod'],
})
