import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Set HERE, once, rather than in each test file.
    //
    // HOME sandboxes where a unit FILE is written, but launchctl and systemctl
    // always address the REAL user's domain. Any test that reaches the install
    // path therefore registers a genuine background service on the developer's
    // machine, pointed at a temp directory that is about to be deleted.
    //
    // That has now happened twice — first when the daemon tests were added,
    // then again when installing the integration started registering the
    // service, which silently pulled a second test file into the blast radius.
    // A per-file opt-in is one someone will forget; this one covers every test
    // that inherits the environment.
    env: { AGENTCHAT_SERVICE_DRY_RUN: '1' },
  },
})
