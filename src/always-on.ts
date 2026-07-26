// ─── Registering always-on ──────────────────────────────────────────────────
//
// Installation and authentication are DIFFERENT lifecycles, and conflating them
// was a real defect. The service used to be created by `daemon install`, which
// refuses without credentials — so installing the product gave you no always-on,
// `logout` left a service that could not resolve an identity (exit 1, restarted
// forever by the service manager), and signing back in restored nothing.
//
// Registering the service needs no credentials. The daemon is resident: it
// idles when there is no identity and connects when one appears. This is the
// shape every comparable daemon uses — tailscaled is installed and running
// before `tailscale up`, and logging out idles it rather than uninstalling it.
//
// Lives in its own module so the session hooks can call it without importing
// the CLI entrypoint, which imports the hooks.

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  installService,
  uninstallService,
  markAlwaysOnWanted,
  alwaysOnWanted,
  alwaysOnOptedOut,
} from '@agentchatme/agent-core'
import { identityHome, SERVICE_LABEL, serviceEnv, shippedDaemonPath, stableDaemonPath } from './host.js'

export interface EnsureResult {
  ok: boolean
  detail?: string
}

/**
 * Register the always-on service. Idempotent, best-effort, credential-free.
 * Never throws — it must not fail whatever called it.
 */
export function ensureAlwaysOn(opts: { force?: boolean } = {}): EnsureResult {
  const home = identityHome()
  // A deliberate `daemon disable` outranks any implicit re-registration. Only
  // an explicit `daemon install` clears it.
  if (!opts.force && alwaysOnOptedOut(home)) return { ok: false, detail: 'switched off by the user' }
  if (!opts.force && alwaysOnWanted(home)) return { ok: true }
  try {
    const src = shippedDaemonPath()
    if (!fs.existsSync(src)) {
      throw new Error(`the daemon bundle is missing from this install (expected ${src})`)
    }
    const entry = stableDaemonPath()
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.copyFileSync(src, entry)
    fs.chmodSync(entry, 0o755)
    installService({ label: SERVICE_LABEL, home, entry, env: serviceEnv() })
    markAlwaysOnWanted(home)
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: String(err instanceof Error ? err.message : err) }
  }
}

/** Remove the service. The only thing that does. */
export function removeAlwaysOn(): void {
  uninstallService({ label: SERVICE_LABEL, home: identityHome() })
}
