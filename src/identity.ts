import { createIdentityCommands, renderAnchorBlock, type HostProfile } from '@agentchatme/agent-core'
import { identityHome, anchorFile, invocation, LABEL } from './host.js'

// ─── This agent, described once ─────────────────────────────────────────────
//
// register / login / recover / status / logout / doctor are a contract with the
// AgentChat server — the pending-state machine, the error vocabulary, what a
// credential file holds — so the flows live in @agentchatme/agent-core and this
// file only says which agent they act on.
//
// It used to be ~510 lines here and ~515 in the Codex integration, 94%
// identical, and they had already drifted: this copy reported `"host": "codex"`
// in `status --json`.
//
// Sharing the flow does not weaken the guarantee. A profile can only describe
// its OWN agent — there is no field naming another host, and nothing here reads
// a `--platform`. The commands built from it can reach exactly one home.

const profile: HostProfile = {
  label: LABEL,
  id: 'claude-code',
  home: identityHome,
  anchorFile,
  invocation,
  renderAnchor: renderAnchorBlock,
  // Nothing to un-wire: Claude Code installs and removes the plugin itself, so
  // logout only drops this agent's credentials and its anchor.
  logoutHints: () => ['Remove the plugin itself with: /plugin uninstall agentchat@agentchatme'],
}

export const { runRegister, runLogin, runRecover, runStatus, runLogout, runDoctor } =
  createIdentityCommands(profile)

export type { RegisterOpts, DoctorOpts } from '@agentchatme/agent-core'
