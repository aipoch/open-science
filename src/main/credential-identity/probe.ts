import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type { IdentityProbeResult } from './selection'

// The executable isolates Security.framework's process-wide UI switch from Electron threads.
// No secret is passed in argv or returned. Unknown output, timeout, and a missing helper fail closed.
export const probeCredentialIdentity = (appName: string): IdentityProbeResult => {
  if (process.platform !== 'darwin' || process.mas) return { status: 'unsupported' }
  try {
    const { executablePath } = createRequire(import.meta.url)(
      '@aipoch/credential-identity-probe-native'
    ) as { executablePath: string }
    const executable = executablePath.replace(/app\.asar([/\\])/u, 'app.asar.unpacked$1')
    const result = spawnSync(executable, [appName], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4096,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (result.error || result.status !== 0 || result.signal) return { status: 'error' }
    const value: unknown = JSON.parse(result.stdout)
    if (!value || typeof value !== 'object') return { status: 'error' }
    const output = value as Record<string, unknown>
    if (output.schemaVersion !== 1 || output.platform !== 'darwin' || output.identity !== appName)
      return { status: 'error' }
    if (
      !['exists', 'not-found', 'access-blocked', 'error', 'unsupported'].includes(
        String(output.status)
      )
    )
      return { status: 'error' }
    return { status: output.status as IdentityProbeResult['status'] }
  } catch {
    return { status: 'error' }
  }
}
