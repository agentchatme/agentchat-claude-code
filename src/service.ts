// ─── Registering the listener service ───────────────────────────────────────
//
// Installation and authentication are DIFFERENT lifecycles. Registering the
// service needs no credentials: the daemon is resident, idles when there is no
// identity and connects when one appears (tailscaled is installed and running
// before `tailscale up`; logging out idles it rather than uninstalling it).

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  atomicCopyFile,
  installService,
  uninstallService,
  markAlwaysOnWanted,
  alwaysOnWanted,
  alwaysOnOptedOut,
  serviceDefinitionCurrent,
  readAlwaysOnInstalledVersion,
  markAlwaysOnInstalledVersion,
  clearAlwaysOnInstalledVersion,
  newerRelease,
} from '@agentchatme/agent-core'
import { identityHome, serviceEnv, serviceLabel, supersededServiceLabels } from './host.js'
import { VERSION } from './version.js'

const DAEMON_REL = path.join('bin', 'agentchat-daemon.mjs')

/** The daemon bundle as published beside this running CLI bundle. */
export function shippedDaemonPath(): string {
  // Anchored to THIS MODULE, not process.argv[1]: under npx argv[1] is the bin
  // shim in node_modules/.bin, and the daemon is not beside that.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon-main.js')
}

/** The durable path the installed service runs — outside the disposable npx cache. */
export function stableDaemonPath(): string {
  return path.join(identityHome(), DAEMON_REL)
}

export function copyDaemonBundle(): string {
  const src = shippedDaemonPath()
  if (!fs.existsSync(src)) throw new Error(`the daemon bundle is missing from this install (expected ${src})`)
  const dest = stableDaemonPath()
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (path.resolve(src) !== path.resolve(dest)) atomicCopyFile(src, dest)
  else fs.chmodSync(dest, 0o755)
  return dest
}

export interface EnsureResult {
  ok: boolean
  /**
   * installed: registered now; current: already registered (this release, or
   * a newer one left as it is); opted_out: the person switched it off, nothing
   * done; failed: could not be registered (`detail` says why).
   */
  outcome: 'installed' | 'current' | 'opted_out' | 'failed'
  detail?: string
}

function serviceOpts() {
  return { label: serviceLabel(), home: identityHome(), entry: stableDaemonPath(), env: serviceEnv(), supersedes: supersededServiceLabels() }
}

/**
 * Register the listener service: the resident daemon that holds the socket and
 * starts a headless run on each wake. Idempotent, best-effort,
 * credential-free. Never throws — it must not fail whatever called it.
 *
 * Install, `login`, `register`, `recover` and `doctor --fix` call it without
 * `force`: it never replaces a service a NEWER release registered (an older
 * `npx` cache running `login` must not downgrade it). An explicit
 * `daemon install` (`force`) installs this release whatever is there, so a
 * deliberate rollback stays possible.
 */
export function ensureListenerService(opts: { force?: boolean } = {}): EnsureResult {
  const home = identityHome()
  // A deliberate `daemon disable` outranks any implicit re-registration. Only
  // an explicit `daemon install` clears it.
  if (!opts.force && alwaysOnOptedOut(home)) return { ok: false, outcome: 'opted_out', detail: 'switched off by the user' }
  try {
    const service = serviceOpts()
    if (!opts.force && alwaysOnWanted(home) && fs.existsSync(service.entry)) {
      const installed = readAlwaysOnInstalledVersion(home)
      if (installed !== null && newerRelease(installed, VERSION)) {
        return { ok: true, outcome: 'current', detail: `${serviceLabel()}; a newer release (${installed}) registered it, left as it is` }
      }
      if (installed === VERSION && serviceDefinitionCurrent(service)) return { ok: true, outcome: 'current', detail: serviceLabel() }
    }
    const entry = copyDaemonBundle()
    installService({ ...service, entry })
    markAlwaysOnInstalledVersion(home, VERSION)
    markAlwaysOnWanted(home)
    return { ok: true, outcome: 'installed', detail: serviceLabel() }
  } catch (err) {
    return { ok: false, outcome: 'failed', detail: String(err instanceof Error ? err.message : err) }
  }
}

/** Is the installed service current (definition, durable bundle, version marker)? One a newer release registered counts: it is left as it is. */
export function listenerServiceCurrent(): boolean {
  const home = identityHome()
  const service = serviceOpts()
  if (!alwaysOnWanted(home) || !fs.existsSync(service.entry)) return false
  const installed = readAlwaysOnInstalledVersion(home)
  if (installed !== null && newerRelease(installed, VERSION)) return true
  return installed === VERSION && serviceDefinitionCurrent(service)
}

/**
 * Remove the service. The only thing that does. Throws — and removes nothing
 * — when the service under this config's label serves another identity home.
 */
export function removeListenerService(): void {
  const home = identityHome()
  uninstallService({ label: serviceLabel(), home, supersedes: supersededServiceLabels() })
  clearAlwaysOnInstalledVersion(home)
}
