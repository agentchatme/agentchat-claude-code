import { defineConfig } from 'tsup'

// Two self-contained ESM files, built from one config so they can never drift
// in target or inlining:
//
//   dist/index.js        the CLI + hooks. Stamped into plugin/bin/agentchat.
//   dist/daemon-main.js  the always-on daemon. Stamped beside it, and copied to
//                        a durable path at `daemon install`.
//
// The plugin is git-cloned with no install step, so BOTH must run with no
// node_modules beside them: `splitting:false` plus a total `noExternal` is what
// makes each file standalone. A split bundle, or one external import, is a hard
// crash at startup for every user.
//
// The `createRequire` line matters only to the daemon: `ws` is CommonJS and
// reaches for `require` at runtime, which plain ESM has no binding for ("Dynamic
// require of events is not supported"). Defining it from `import.meta.url`
// satisfies that. The CLI does not import `ws`, so its bundle just carries an
// unused binding.
const BANNER = [
  '#!/usr/bin/env node',
  'import{createRequire as __acCreateRequire}from"node:module";',
  'const require=__acCreateRequire(import.meta.url);',
].join('\n')

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon-main.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: true,
  splitting: false,
  target: 'node20',
  banner: { js: BANNER },
  // EVERY dependency is inlined — see above.
  noExternal: ['@agentchatme/agent-core', 'agentchatme', 'zod', 'ws'],
})
