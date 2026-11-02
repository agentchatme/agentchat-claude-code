// ─── Registering the doorbell service ───────────────────────────────────────
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
} from '@agentchatme/agent-core'
import { identityHome, SERVICE_LABEL, serviceEnv } from './host.js'
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
  detail?: string
}

function serviceOpts() {
  return { label: SERVICE_LABEL, home: identityHome(), entry: stableDaemonPath(), env: serviceEnv() }
}

/**
 * Register the doorbell service. Idempotent, best-effort, credential-free.
 * Never throws — it must not fail whatever called it.
 */
export function ensureDoorbellService(opts: { force?: boolean } = {}): EnsureResult {
  const home = identityHome()
  // A deliberate `daemon disable` outranks any implicit re-registration. Only
  // an explicit `daemon install` clears it.
  if (!opts.force && alwaysOnOptedOut(home)) return { ok: false, detail: 'switched off by the user' }
  try {
    const service = serviceOpts()
    if (
      !opts.force &&
      alwaysOnWanted(home) &&
      readAlwaysOnInstalledVersion(home) === VERSION &&
      fs.existsSync(service.entry) &&
      serviceDefinitionCurrent(service)
    ) {
      return { ok: true }
    }
    const entry = copyDaemonBundle()
    installService({ ...service, entry })
    markAlwaysOnInstalledVersion(home, VERSION)
    markAlwaysOnWanted(home)
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: String(err instanceof Error ? err.message : err) }
  }
}

/** Is the installed service current (definition, durable bundle, version marker)? */
export function doorbellServiceCurrent(): boolean {
  const home = identityHome()
  const service = serviceOpts()
  return (
    alwaysOnWanted(home) &&
    fs.existsSync(service.entry) &&
    readAlwaysOnInstalledVersion(home) === VERSION &&
    serviceDefinitionCurrent(service)
  )
}

/** Remove the service. The only thing that does. */
export function removeDoorbellService(): void {
  const home = identityHome()
  uninstallService({ label: SERVICE_LABEL, home })
  clearAlwaysOnInstalledVersion(home)
}
