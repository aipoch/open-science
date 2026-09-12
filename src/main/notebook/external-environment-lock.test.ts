import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { captureNotebookEnvironmentLock, decodeNotebookEnvironmentLock } from './environment-lock'
import type { NotebookEnvironmentLock, NotebookEnvironmentManifest } from '../../shared/notebook'
import { nativeLockRestoreState } from './native-lock-restoration'

const content = JSON.stringify({
  R: { Version: '4.4.3', Repositories: [{ Name: 'CRAN', URL: 'https://cloud.r-project.org' }] },
  Packages: {
    glue: { Package: 'glue', Version: '1.8.0', Source: 'Repository', Repository: 'CRAN' }
  }
})
const file = {
  path: 'r/renv.lock',
  content,
  checksum: createHash('sha256').update(content).digest('hex')
}
const lock: NotebookEnvironmentLock = {
  schemaVersion: 2,
  format: 'environment-lock-bundle',
  kernelKind: 'r',
  environmentName: 'external-r',
  platform: 'win32',
  architecture: 'x64',
  externalRuntime: { version: '4.4.3', installerVersion: '1.2.4' },
  untrackedPackages: ['r:glue'],
  components: [{ ecosystem: 'r', format: 'renv-lock', resolution: 'locked', files: [file] }]
}
const manifest: NotebookEnvironmentManifest = {
  schemaVersion: 1,
  captureKind: 'completed-run',
  capturedAt: '2026-09-11T00:00:00Z',
  installedInventory: {
    capturedAt: '2026-09-11T00:00:00Z',
    source: 'full-scan',
    validation: 'full-scan'
  },
  kernelKind: 'r',
  environmentName: 'external-r',
  runtimeSource: 'external',
  runtimeVersion: '4.4.3',
  platform: 'win32',
  architecture: 'x64',
  inventorySources: ['kernel-native'],
  complete: true,
  captureStatus: 'complete',
  packages: [
    {
      name: 'glue',
      ecosystem: 'r',
      version: '1.8.0',
      versionStatus: 'known',
      loadedState: 'loaded',
      evidenceSources: ['r-session-info']
    }
  ]
}

describe('conditional external environment locks', () => {
  it('accepts an explicit native prerequisite and never disguises it as a v1 Conda lock', () => {
    expect(decodeNotebookEnvironmentLock(JSON.stringify(lock)).status).toBe('valid')
    expect(nativeLockRestoreState(lock, manifest.packages).state).toBe('ready')
    for (const change of [
      { schemaVersion: 1 },
      { externalRuntime: undefined },
      { architecture: undefined },
      { externalRuntime: { ...lock.externalRuntime, command: '/host/Rscript' } }
    ])
      expect(decodeNotebookEnvironmentLock(JSON.stringify({ ...lock, ...change })).status).toBe(
        'corrupt'
      )
  })

  it.each(['AMD64', 'ARM64', 'x86_64', 'aarch64'])(
    'accepts runtime architecture %s without rewriting lock evidence',
    (architecture) => {
      const result = decodeNotebookEnvironmentLock(JSON.stringify({ ...lock, architecture }))
      expect(result.status).toBe('valid')
      if (result.status === 'valid') expect(result.value.architecture).toBe(architecture)
    }
  )

  it('accepts Windows Python machine casing with hash-pinned dependency evidence', () => {
    const requirements = 'idna==3.10 --hash=sha256:' + 'a'.repeat(64) + '\n'
    const pythonLock: NotebookEnvironmentLock = {
      ...lock,
      kernelKind: 'python',
      architecture: 'AMD64',
      externalRuntime: { version: '3.12.7', installerVersion: '24.2' },
      untrackedPackages: ['python:idna'],
      components: [
        {
          ecosystem: 'python',
          format: 'pip-requirements',
          resolution: 'locked',
          files: [
            {
              path: 'python/requirements.txt',
              content: requirements,
              checksum: createHash('sha256').update(requirements).digest('hex')
            }
          ]
        }
      ]
    }
    expect(decodeNotebookEnvironmentLock(JSON.stringify(pythonLock)).status).toBe('valid')
  })

  it('rejects unsupported external architectures', () => {
    expect(
      decodeNotebookEnvironmentLock(JSON.stringify({ ...lock, architecture: 'mips' })).status
    ).toBe('corrupt')
  })

  it('captures native R evidence as conditional and refuses observed version drift', async () => {
    const execute = vi.fn(async (argv: string[]) =>
      argv.at(-1)?.includes('snapshot') ? content : '1.2.4'
    )
    const target = {
      language: 'r' as const,
      environmentName: 'external-r',
      runtimeSource: 'external' as const,
      command: '/user/Rscript'
    }
    const result = await captureNotebookEnvironmentLock(target, manifest, { execute })
    expect(result).toMatchObject({
      state: 'captured',
      captureStatus: 'partial',
      partialReasons: ['external-interpreter-required'],
      lock: { schemaVersion: 2 }
    })
    const drifted = { ...manifest, packages: [{ ...manifest.packages[0]!, version: '9.0.0' }] }
    expect(await captureNotebookEnvironmentLock(target, drifted, { execute })).toMatchObject({
      state: 'unavailable'
    })
    expect(execute.mock.calls.every(([argv]) => argv[0] === '/user/Rscript')).toBe(true)
  })
})
