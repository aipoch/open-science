import { describe, expect, it } from 'vitest'
import { projectDiagnosticEnvironment } from './environment'

describe('diagnostic environment', () => {
  it('retains stored routing and runtime facts without copying configuration secrets or paths', () => {
    const snapshot = projectDiagnosticEnvironment(
      {
        agentFrameworkId: 'codex',
        activeProviderId: 'provider-1',
        activeModel: 'vendor/model',
        defaultPermissionProfile: 'ask',
        localShellRuntime: 'wsl2-bash',
        networkProxy: {
          mode: 'manual',
          server: 'http://private-host:1234',
          bypassRules: 'private-host'
        },
        claude: { version: '1.2.3', resolvedPath: '/private/runtime' },
        codex: { version: '0.1.2', nativeVersion: '0.3.4', nativePath: '/private/codex' },
        notebookNetwork: { allowedDomains: ['private-host'], disabledOpenScienceDomains: [] },
        providers: [{ apiKey: 'do-not-export', endpoint: 'https://private-host' }],
        githubTokenRef: 'do-not-export',
        environment: { SECRET: 'do-not-export' }
      },
      '0.34.0'
    )
    expect(snapshot.storedDefaults).toMatchObject({
      frameworkId: 'codex',
      model: 'vendor/model',
      permissionProfile: 'ask',
      proxyMode: 'manual'
    })
    expect(snapshot.storedRuntimeVersions).toMatchObject({ claude: '1.2.3', codexNative: '0.3.4' })
    expect(snapshot.notebookNetwork).toMatchObject({
      allowedDomainCount: 1,
      enforcementStatus: 'not-observed'
    })
    const exported = JSON.stringify(snapshot)
    for (const secret of ['private-host', '/private/', 'do-not-export'])
      expect(exported).not.toContain(secret)
  })

  it('keeps missing or unrecognized old values unknown instead of inventing effective defaults', () => {
    const snapshot = projectDiagnosticEnvironment(
      {
        agentFrameworkId: 'future-framework',
        activeModel: 'https://secret/model',
        codex: { version: '/home/private/runtime' }
      },
      '0.34.0'
    )
    expect(snapshot.storedDefaults).toMatchObject({
      frameworkId: null,
      model: null,
      proxyMode: null
    })
    expect(snapshot.storedRuntimeVersions).toMatchObject({ codexAdapter: null })
    expect(snapshot.observation).toContain('not failure-time')
    expect(() => projectDiagnosticEnvironment(null, '0.34.0')).not.toThrow()
  })
})
