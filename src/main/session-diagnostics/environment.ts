import { arch, release } from 'node:os'
import { diagnosticText } from './detail'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const choice = (value: unknown, choices: string[]): string | null =>
  typeof value === 'string' && choices.includes(value) ? value : null

const identifier = (value: unknown): string | null =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value) &&
  !value.includes('://') &&
  !value.includes('..')
    ? diagnosticText(value)
    : null

// Version fields are persisted detection results, never commands to run during export.
const version = (value: unknown): string | null =>
  typeof value === 'string' && /^v?\d[0-9a-zA-Z.+_()-]{0,119}$/.test(value) ? value : null

/** Pure projection: no SettingsService loading, migration, credentials or runtime probes. */
export function projectDiagnosticEnvironment(
  settings: unknown,
  appVersion: string
): Record<string, unknown> {
  const source = object(settings)
  const network = object(source.notebookNetwork)
  const count = (value: unknown): number | null => (Array.isArray(value) ? value.length : null)
  return {
    format: 'diagnostic-environment',
    version: 1,
    observedAt: new Date().toISOString(),
    observation: 'stored-configuration-at-export; not failure-time or live runtime state',
    application: {
      version: diagnosticText(appVersion, undefined, 120),
      platform: process.platform,
      arch: arch(),
      osRelease: release(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron ?? null
    },
    storedDefaults: {
      frameworkId: choice(source.agentFrameworkId, [
        'claude-code',
        'opencode',
        'codebuddy',
        'codex'
      ]),
      providerId: identifier(source.activeProviderId),
      model: identifier(source.activeModel),
      reasoningEffort: choice(source.reasoningEffort, [
        'default',
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra'
      ]),
      permissionProfile: choice(source.defaultPermissionProfile, ['ask', 'auto', 'full']),
      localShellRuntime: choice(source.localShellRuntime, ['powershell', 'wsl2-bash']),
      proxyMode: choice(object(source.networkProxy).mode, ['system', 'manual', 'direct'])
    },
    storedRuntimeVersions: {
      claude: version(object(source.claude).version),
      opencode: version(source.opencodeVersion),
      codebuddy: version(source.codebuddyVersion),
      codexAdapter: version(object(source.codex).version),
      codexNative: version(object(source.codex).nativeVersion)
    },
    notebookNetwork: {
      allowedDomainCount: count(network.allowedDomains),
      disabledDomainCount: count(network.disabledOpenScienceDomains),
      disabledDomainGroupCount: count(network.disabledOpenScienceDomainGroups),
      enforcementStatus: 'not-observed'
    },
    omissionPolicy:
      'Null means not recorded or not recognized. Session-specific configuration is in session.json. Paths, endpoints, domain names, credentials, environment variables and arbitrary settings are excluded.'
  }
}
