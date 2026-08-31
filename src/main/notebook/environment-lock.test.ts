import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const diagnosticWarn = vi.hoisted(() => vi.fn())
vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => ({ warn: diagnosticWarn })
}))

import type { NotebookEnvironmentManifest } from '../../shared/notebook'
import { restoreNativeEnvironmentLock } from './native-lock-restoration'
import {
  captureNotebookEnvironmentLock,
  decodeNotebookEnvironmentLock,
  EnvironmentLockCaptureOwner,
  parseCondaPackageNames,
  validateExplicitLock
} from './environment-lock'

const lockFile = (
  path: string,
  content: string
): { path: string; content: string; checksum: string } => ({
  path,
  content,
  checksum: createHash('sha256').update(content).digest('hex')
})

const manifest = (
  overrides: Partial<NotebookEnvironmentManifest> = {}
): NotebookEnvironmentManifest => ({
  schemaVersion: 1,
  captureKind: 'completed-run',
  capturedAt: '2026-09-02T00:00:00.000Z',
  installedInventory: {
    capturedAt: '2026-09-02T00:00:00.000Z',
    source: 'full-scan',
    validation: 'full-scan'
  },
  kernelKind: 'python',
  environmentName: 'default-python',
  runtimeSource: 'managed',
  platform: 'darwin',
  architecture: 'arm64',
  inventorySources: ['kernel-native', 'interpreter-native'],
  packages: [
    {
      name: 'NumPy',
      version: '2.3.2',
      versionStatus: 'known',
      ecosystem: 'python',
      evidenceSources: ['python-importlib-metadata']
    }
  ],
  complete: true,
  captureStatus: 'complete',
  ...overrides
})

const condaInventory = (...names: string[]): string =>
  JSON.stringify(
    names.map((name, index) => ({
      name,
      url: `https://conda.example/osx-arm64/${name}-1.0-${index}.conda`,
      md5: index.toString(16).padStart(32, '0')
    }))
  )

describe('captureNotebookEnvironmentLock', () => {
  it.each(['python', 'r'] as const)('records a safe %s lock failure stage', async (language) => {
    diagnosticWarn.mockClear()
    const result = await captureNotebookEnvironmentLock(
      {
        language,
        runtimeSource: 'managed',
        environmentName: 'private-name',
        condaPrefix: '/missing/private-prefix'
      },
      manifest({ kernelKind: language }),
      {
        micromamba: '/private/micromamba',
        execute: async () => {
          throw new Error('PRIVATE-CODE token=private-token')
        }
      }
    )
    expect(result).toEqual({ state: 'unavailable', reason: 'environment-lock-capture-failed' })
    expect(diagnosticWarn).toHaveBeenCalledWith('environment lock capture failed', {
      language,
      stage: 'reading-conda-inventory',
      errorCategory: 'error'
    })
    expect(JSON.stringify(diagnosticWarn.mock.calls)).not.toMatch(/private-|PRIVATE-/)
  })

  it.each(['DESeq2', 'org.Hs.eg.db', 'airway'])(
    'retains exact Bioconda coverage for %s while rejecting changed or external copies',
    async (name) => {
      const pkg: NotebookEnvironmentManifest['packages'][number] = {
        name,
        version: '1.0',
        versionStatus: 'known' as const,
        ecosystem: 'r' as const,
        loadedState: 'loaded' as const,
        libraryScope: 'environment' as const,
        evidenceSources: ['r-installed-packages' as const, 'r-session-info' as const],
        source: { type: 'bioconductor' as const, version: '3.20' }
      }
      const take = (
        overrides: Partial<typeof pkg> = {},
        condaVersion = '1.0'
      ): ReturnType<typeof captureNotebookEnvironmentLock> =>
        captureNotebookEnvironmentLock(
          {
            language: 'r',
            environmentName: 'analysis',
            runtimeSource: 'managed',
            condaPrefix: '/runtime/r'
          },
          manifest({ kernelKind: 'r', packages: [{ ...pkg, ...overrides }] }),
          {
            micromamba: 'micromamba',
            execute: async () =>
              JSON.stringify([
                {
                  name: `bioconductor-${name.toLowerCase()}`,
                  version: condaVersion,
                  url: `https://conda.example/${name}.conda`,
                  md5: 'a'.repeat(32)
                }
              ])
          }
        )
      expect(await take()).toMatchObject({ state: 'captured', captureStatus: 'complete' })
      expect(await take({ version: '2.0' })).toMatchObject({
        state: 'captured',
        captureStatus: 'partial'
      })
      expect(await take({ versionStatus: 'unavailable' })).toMatchObject({
        state: 'captured',
        captureStatus: 'partial'
      })
      expect(await take({ libraryScope: 'user' })).toMatchObject({
        state: 'captured',
        captureStatus: 'partial'
      })
      expect(await take({}, '')).toMatchObject({ state: 'captured', captureStatus: 'partial' })
    }
  )

  it.each(['3.20', '3.21', undefined])(
    'checks native Bioconductor release %s against the captured lock',
    async (release) => {
      const root = await mkdtemp(join(tmpdir(), 'bioc-native-lock-'))
      try {
        await writeFile(
          join(root, 'renv.lock'),
          JSON.stringify({
            R: { Version: '4.4.3' },
            Bioconductor: { Version: '3.20' },
            Packages: {
              DESeq2: { Package: 'DESeq2', Version: '1.46.0', Source: 'Bioconductor' },
              ggplot2: {
                Package: 'ggplot2',
                Version: '3.5.2',
                Source: 'Repository',
                Repository: 'CRAN'
              }
            }
          })
        )
        const result = await captureNotebookEnvironmentLock(
          {
            language: 'r',
            environmentName: 'analysis',
            runtimeSource: 'managed',
            condaPrefix: root
          },
          manifest({
            kernelKind: 'r',
            packages: [
              {
                name: 'DESeq2',
                version: '1.46.0',
                versionStatus: 'known',
                ecosystem: 'r',
                evidenceSources: ['r-installed-packages'],
                loadedState: 'loaded',
                libraryScope: 'environment',
                source: { type: 'bioconductor', ...(release ? { version: release } : {}) }
              },
              {
                name: 'ggplot2',
                version: '3.5.2',
                versionStatus: 'known',
                ecosystem: 'r',
                evidenceSources: ['r-installed-packages'],
                loadedState: 'loaded',
                libraryScope: 'environment'
              }
            ]
          }),
          {
            micromamba: 'micromamba',
            workspace: { sessionRoot: root, searchRoots: [root] },
            execute: async () => condaInventory('r-base', 'r-renv')
          }
        )
        expect(result).toMatchObject({
          state: 'captured',
          captureStatus: release === '3.20' ? 'complete' : 'partial'
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.each([
    ['2.3', '2.3.0', 'complete'],
    ['2.3.0.0', '2.3', 'complete'],
    ['2.3.1', '2.3', 'partial'],
    ['2.3+custom', '2.3', 'partial'],
    ['2.3rc1', '2.3', 'partial']
  ])(
    'compares Python release spellings %s and %s without losing build suffixes',
    async (version, locked, status) => {
      const result = await captureNotebookEnvironmentLock(
        {
          language: 'python',
          runtimeSource: 'managed',
          environmentName: 'default-python',
          condaPrefix: '/runtime/python'
        },
        manifest({
          packages: [
            {
              name: 'numpy',
              version,
              versionStatus: 'known',
              ecosystem: 'python',
              evidenceSources: ['python-importlib-metadata'],
              loadedState: 'loaded'
            }
          ]
        }),
        {
          micromamba: 'micromamba',
          execute: async () =>
            JSON.stringify([
              {
                name: 'numpy',
                version: locked,
                url: 'https://conda.example/numpy.conda',
                md5: 'a'.repeat(32)
              }
            ])
        }
      )
      expect(result).toMatchObject({ state: 'captured', captureStatus: status })
    }
  )

  it('does not treat missing Python package evidence as a standard-library observation', async () => {
    const result = await captureNotebookEnvironmentLock(
      {
        language: 'python',
        runtimeSource: 'managed',
        environmentName: 'default-python',
        condaPrefix: '/runtime/envs/default-python'
      },
      manifest({
        packages: [
          {
            name: 'unconfirmed-package',
            version: '1.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: [],
            loadedState: 'loaded'
          }
        ]
      }),
      { micromamba: 'micromamba', execute: async () => condaInventory('python') }
    )
    expect(result).toMatchObject({
      state: 'captured',
      captureStatus: 'partial',
      lock: { untrackedPackages: ['python:unconfirmed-package'] }
    })
  })
  it.each(['1.1-3', '1.1.3', '1.1.4'])(
    'compares R package_version spelling %s with the Conda archive version',
    async (version) => {
      const result = await captureNotebookEnvironmentLock(
        {
          language: 'r',
          environmentName: 'default-r',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/default-r'
        },
        manifest({
          kernelKind: 'r',
          packages: [
            {
              name: 'RColorBrewer',
              version,
              versionStatus: 'known',
              ecosystem: 'r',
              evidenceSources: ['r-installed-packages', 'r-session-info'],
              loadedState: 'loaded',
              libraryScope: 'environment'
            }
          ]
        }),
        {
          micromamba: 'micromamba',
          execute: async () =>
            JSON.stringify([
              {
                name: 'r-rcolorbrewer',
                version: '1.1_3',
                url: 'https://conda.example/r-rcolorbrewer-1.1_3.conda',
                md5: '1'.repeat(32)
              }
            ])
        }
      )
      expect(result).toMatchObject({
        state: 'captured',
        captureStatus: version === '1.1.4' ? 'partial' : 'complete'
      })
    }
  )
  it.each(['python', 'r'] as const)(
    'keeps an unused native package out of the %s run lock without losing its inventory evidence',
    async (language) => {
      const sessionRoot = await mkdtemp(join(tmpdir(), 'run-environment-lock-'))
      try {
        await mkdir(join(sessionRoot, 'conda-meta'))
        await writeFile(join(sessionRoot, 'conda-meta', 'history'), 'baseline')
        const capture = new EnvironmentLockCaptureOwner()
        const installed = {
          name: language === 'python' ? 'pandas' : 'dplyr',
          version: '3.0.5',
          versionStatus: 'known' as const,
          ecosystem: language,
          evidenceSources: [
            language === 'python' ? 'python-importlib-metadata' : 'r-installed-packages',
            language === 'python' ? 'python-kernel-modules' : 'r-session-info'
          ] as const,
          loadedState: 'installed-only' as const
        }
        const base = manifest({
          kernelKind: language,
          packages: [
            {
              name: language === 'python' ? 'numpy' : 'stats',
              version: '1.0',
              versionStatus: 'known',
              ecosystem: language,
              evidenceSources: [
                language === 'python' ? 'python-kernel-modules' : 'r-installed-packages'
              ],
              loadedState: 'loaded',
              ...(language === 'r' ? { priority: 'base' as const } : {})
            },
            { ...installed, evidenceSources: [...installed.evidenceSources] }
          ]
        })
        const take = (): ReturnType<EnvironmentLockCaptureOwner['capture']> =>
          capture.capture(
            {
              language,
              environmentName: base.environmentName,
              runtimeSource: 'managed',
              condaPrefix: sessionRoot
            },
            base,
            {
              micromamba: 'micromamba',
              environmentFingerprint: 'unchanged',
              execute: async () =>
                JSON.stringify([
                  ...JSON.parse(
                    condaInventory(language === 'python' ? 'python' : 'r-base', 'numpy')
                  ),
                  ...(language === 'python'
                    ? [{ name: 'pandas', version: '3.0.5', channel: 'pypi' }]
                    : [])
                ])
            }
          )
        const unused = await take()
        expect(unused).toMatchObject({
          state: 'captured',
          captureStatus: 'complete',
          lock: { omittedPackages: [language + ':' + installed.name] }
        })
        expect(base.packages).toHaveLength(2)
        if (unused.state !== 'captured') throw new Error('Expected run lock')
        expect(unused.lock.untrackedPackages).toBeUndefined()
        expect(decodeNotebookEnvironmentLock(JSON.stringify(unused.lock)).status).toBe('valid')
        const spawn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
        await restoreNativeEnvironmentLock({
          lock: unused.lock,
          prefix: join(sessionRoot, 'restore'),
          locksRoot: join(sessionRoot, 'locks'),
          spawn
        })
        expect(spawn).not.toHaveBeenCalled()

        // Same installed inventory, but the next cell actually loads the native package.
        base.packages[1]!.loadedState = 'loaded'
        expect(await take()).toMatchObject({
          state: 'captured',
          captureStatus: 'partial',
          lock: { untrackedPackages: [language + ':' + installed.name] }
        })
        base.packages[1]!.loadedState = 'unknown'
        expect(await take()).toMatchObject({ state: 'captured', captureStatus: 'partial' })
        base.packages[1]!.loadedState = 'installed-only'
        base.packages[1]!.evidenceSources = [
          language === 'python' ? 'python-importlib-metadata' : 'r-installed-packages'
        ]
        expect(await take()).toMatchObject({ state: 'captured', captureStatus: 'partial' })
        base.packages[1]!.evidenceSources = [...installed.evidenceSources]
        for (const omittedPackages of [
          [language + ':' + installed.name, language + ':' + installed.name],
          ['unknown:package'],
          [language + ':../package']
        ]) {
          expect(
            decodeNotebookEnvironmentLock(JSON.stringify({ ...unused.lock, omittedPackages }))
              .status
          ).toBe('corrupt')
        }
        expect(
          decodeNotebookEnvironmentLock(
            JSON.stringify({
              ...unused.lock,
              untrackedPackages: unused.lock.omittedPackages
            })
          ).status
        ).toBe('corrupt')

        base.packages[1]!.loadedState = 'installed-only'
        base.captureStatus = 'partial'
        base.complete = false
        expect(await take()).toMatchObject({
          state: 'captured',
          captureStatus: 'partial',
          lock: { untrackedPackages: [language + ':' + installed.name] }
        })
      } finally {
        await rm(sessionRoot, { recursive: true, force: true })
      }
    }
  )

  it.each(['python', 'r'] as const)(
    'restores a used %s native dependency while excluding an unrelated unlocked package',
    async (language) => {
      const root = await mkdtemp(join(tmpdir(), 'mixed-run-lock-'))
      try {
        const locked =
          language === 'python'
            ? `used-package==1.0 --hash=sha256:${'1'.repeat(64)}\n`
            : JSON.stringify({
                R: { Version: '4.4.3' },
                Packages: {
                  usedpackage: { Version: '1.0', Source: 'Repository', Repository: 'CRAN' }
                }
              })
        await writeFile(
          join(root, language === 'python' ? 'requirements.lock' : 'renv.lock'),
          locked
        )
        const usedName = language === 'python' ? 'used-package' : 'usedpackage'
        const packages: NotebookEnvironmentManifest['packages'] = [usedName, 'unrelated'].map(
          (name, index) => ({
            name,
            version: '1.0',
            versionStatus: 'known',
            ecosystem: language,
            evidenceSources:
              language === 'python'
                ? ['python-importlib-metadata', 'python-kernel-modules']
                : ['r-installed-packages', 'r-session-info'],
            loadedState: index === 0 ? 'loaded' : 'installed-only'
          })
        )
        const take = (): ReturnType<typeof captureNotebookEnvironmentLock> =>
          captureNotebookEnvironmentLock(
            { language, environmentName: 'mixed', runtimeSource: 'managed', condaPrefix: root },
            manifest({ kernelKind: language, packages }),
            {
              micromamba: 'micromamba',
              workspace: { sessionRoot: root, searchRoots: [root] },
              execute: async () =>
                condaInventory(
                  language === 'python' ? 'python' : 'r-base',
                  language === 'python' ? 'pip' : 'r-renv'
                )
            }
          )
        const result = await take()
        expect(result).toMatchObject({
          state: 'captured',
          captureStatus: 'complete',
          lock: {
            untrackedPackages: [language + ':' + usedName],
            omittedPackages: [language + ':unrelated']
          }
        })
        if (result.state !== 'captured') throw new Error('No captured lock')
        const spawn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
        await restoreNativeEnvironmentLock({
          lock: result.lock,
          prefix: join(root, 'restored'),
          locksRoot: join(root, 'locks'),
          spawn
        })
        expect(spawn).toHaveBeenCalledOnce()
        // An unused entry explicitly present in the native lock is still restored. Never
        // disguise its version mismatch by labelling it an omitted package.
        const stale =
          language === 'python'
            ? locked + `unrelated==2.0 --hash=sha256:${'2'.repeat(64)}\n`
            : JSON.stringify({
                ...JSON.parse(locked),
                Packages: {
                  ...JSON.parse(locked).Packages,
                  unrelated: { Version: '2.0', Source: 'Repository', Repository: 'CRAN' }
                }
              })
        await writeFile(
          join(root, language === 'python' ? 'requirements.lock' : 'renv.lock'),
          stale
        )
        const conflict = await take()
        expect(conflict).toMatchObject({ state: 'captured', captureStatus: 'partial' })
        if (conflict.state !== 'captured') throw new Error('No captured evidence')
        expect(conflict.lock.omittedPackages).toBeUndefined()
        expect(conflict.lock.untrackedPackages).toContain(language + ':unrelated')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.each(['renv-lock', 'pak-lock'] as const)(
    'checks exact R inventory names before certifying %s coverage',
    async (format) => {
      const root = await mkdtemp(join(tmpdir(), 'r-lock-identity-'))
      try {
        for (const name of ['R.utils', 'r.utils', 'R..utils']) {
          await writeFile(
            join(root, format === 'renv-lock' ? 'renv.lock' : 'pkg.lock'),
            JSON.stringify(
              format === 'renv-lock'
                ? { Packages: { [name]: { Package: name, Version: '1.0' } } }
                : { packages: [{ package: name, version: '1.0' }] }
            )
          )
          const result = await captureNotebookEnvironmentLock(
            {
              language: 'r',
              environmentName: 'analysis',
              runtimeSource: 'managed',
              condaPrefix: root
            },
            manifest({
              kernelKind: 'r',
              packages: [
                {
                  name: 'R.utils',
                  version: '1.0',
                  versionStatus: 'known',
                  ecosystem: 'r',
                  loadedState: 'loaded',
                  evidenceSources: ['r-installed-packages', 'r-session-info']
                }
              ]
            }),
            {
              micromamba: 'micromamba',
              workspace: { sessionRoot: root, searchRoots: [root] },
              execute: async () =>
                condaInventory('r-base', format === 'renv-lock' ? 'r-renv' : 'r-pak')
            }
          )
          expect(result).toMatchObject({
            state: 'captured',
            captureStatus: name === 'R.utils' ? 'complete' : 'partial',
            lock: { untrackedPackages: ['r:r-utils'] }
          })
          if (result.state !== 'captured') throw new Error('No captured lock')
          expect(decodeNotebookEnvironmentLock(JSON.stringify(result.lock)).status).toBe('valid')
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.each(['conditional', 'comment'] as const)(
    'distinguishes Python requirement markers from comments during capture: %s',
    async (scenario) => {
      const sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-requirement-marker-'))
      try {
        const content =
          scenario === 'conditional'
            ? `numpy==2.3.2; sys_platform == "win32" --hash=sha256:${'1'.repeat(64)}\n`
            : `numpy==2.3.2 --hash=sha256:${'1'.repeat(64)} # captured; no marker\n`
        await writeFile(join(sessionRoot, 'requirements.lock'), content)
        const result = await captureNotebookEnvironmentLock(
          {
            language: 'python',
            environmentName: 'analysis',
            runtimeSource: 'managed',
            condaPrefix: join(sessionRoot, 'env')
          },
          manifest(),
          {
            micromamba: 'micromamba',
            execute: async () => condaInventory('python', 'pip'),
            workspace: { sessionRoot, searchRoots: [sessionRoot] }
          }
        )
        expect(result).toMatchObject({
          state: 'captured',
          captureStatus: scenario === 'conditional' ? 'partial' : 'complete',
          lock: {
            components: expect.arrayContaining([
              expect.objectContaining({
                format: 'pip-requirements',
                resolution: scenario === 'conditional' ? 'best-effort' : 'locked'
              })
            ])
          }
        })
        if (result.state !== 'captured') throw new Error('Expected captured lock')
        expect(decodeNotebookEnvironmentLock(JSON.stringify(result.lock)).status).toBe('valid')
      } finally {
        await rm(sessionRoot, { recursive: true, force: true })
      }
    }
  )

  it.each(['absent', 'stale', 'user-library', 'matched', 'conda-version-spelling'] as const)(
    'checks R recommended packages against the actual Conda baseline: %s',
    async (scenario) => {
      const result = await captureNotebookEnvironmentLock(
        {
          language: 'r',
          environmentName: 'default-r',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/default-r'
        },
        manifest({
          kernelKind: 'r',
          packages: [
            {
              name: 'Matrix',
              version: scenario === 'conda-version-spelling' ? '1.7-1' : '1.7.1',
              versionStatus: 'known',
              ecosystem: 'r',
              evidenceSources: ['r-installed-packages'],
              priority: 'recommended',
              libraryScope: scenario === 'user-library' ? 'user' : 'environment'
            }
          ]
        }),
        {
          micromamba: 'micromamba',
          execute: async () =>
            JSON.stringify([
              ...JSON.parse(condaInventory('r-base')),
              ...(scenario === 'absent'
                ? []
                : [
                    {
                      name: 'r-matrix',
                      version:
                        scenario === 'stale'
                          ? '1.6.0'
                          : scenario === 'conda-version-spelling'
                            ? '1.7_1'
                            : '1.7.1',
                      url: 'https://conda.example/r-matrix.conda',
                      md5: '1'.repeat(32)
                    }
                  ])
            ])
        }
      )
      expect(result).toMatchObject({
        state: 'captured',
        captureStatus:
          scenario === 'matched' || scenario === 'conda-version-spelling' ? 'complete' : 'partial'
      })
      if (
        scenario !== 'matched' &&
        scenario !== 'conda-version-spelling' &&
        result.state === 'captured'
      )
        expect(result.lock.untrackedPackages).toContain('r:matrix')
    }
  )

  it.each(['missing', 'exact', 'stale', 'unobserved', 'inventory-mismatch'] as const)(
    'preserves mixed Conda/PyPI evidence with a %s native lock',
    async (evidence) => {
      const sessionRoot = await mkdtemp(join(tmpdir(), 'mixed-environment-lock-'))
      const content = `pandas==${evidence === 'stale' ? '2.0' : '3.0.5'} --hash=sha256:${'1'.repeat(64)}\n`
      try {
        if (evidence !== 'missing') await writeFile(join(sessionRoot, 'requirements.lock'), content)
        const inventory = JSON.stringify([
          ...JSON.parse(condaInventory('python', 'numpy', 'pip')),
          {
            name: 'pandas',
            version: evidence === 'inventory-mismatch' ? '3.0.6' : '3.0.5',
            channel: 'pypi',
            build_string: 'pypi_0',
            url: '',
            md5: ''
          }
        ])
        const result = await captureNotebookEnvironmentLock(
          {
            language: 'python',
            environmentName: 'default-python',
            runtimeSource: 'managed',
            condaPrefix: sessionRoot
          },
          manifest({
            packages: [
              ...manifest().packages,
              ...(evidence === 'unobserved'
                ? []
                : [
                    {
                      name: 'pandas',
                      version: '3.0.5',
                      versionStatus: 'known' as const,
                      ecosystem: 'python' as const,
                      evidenceSources: ['python-importlib-metadata' as const]
                    }
                  ])
            ]
          }),
          {
            micromamba: 'micromamba',
            execute: async () => inventory,
            workspace: { sessionRoot, searchRoots: [sessionRoot] }
          }
        )
        expect(result).toMatchObject({
          state: 'captured',
          captureStatus: evidence === 'exact' ? 'complete' : 'partial',
          lock: { untrackedPackages: ['python:pandas'] }
        })
        if (result.state !== 'captured') throw new Error('Expected a captured lock.')
        expect(result.lock.components[0]).toMatchObject({ packages: ['numpy', 'pip', 'python'] })
        expect(decodeNotebookEnvironmentLock(JSON.stringify(result.lock)).status).toBe('valid')
        if (evidence === 'exact') {
          const spawn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
          await restoreNativeEnvironmentLock({
            lock: result.lock,
            prefix: join(sessionRoot, 'restored'),
            locksRoot: join(sessionRoot, 'locks'),
            spawn
          })
          expect(spawn).toHaveBeenCalledWith(
            expect.stringContaining('python'),
            expect.arrayContaining(['-m', 'pip', 'install', '--require-hashes', '-r']),
            expect.anything(),
            undefined,
            undefined,
            false,
            expect.any(String),
            { onOutput: undefined, signal: undefined }
          )
        } else {
          expect(result.partialReasons).toContain('non-conda-package-detected')
        }
      } finally {
        await rm(sessionRoot, { recursive: true, force: true })
      }
    }
  )

  it.each(['python', 'r'] as const)(
    'marks a stale %s native lock partial instead of certifying the observed environment',
    async (language) => {
      const sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-stale-native-lock-'))
      const filename = language === 'python' ? 'requirements.lock' : 'renv.lock'
      const content =
        language === 'python'
          ? `numpy==1.0 --hash=sha256:${'1'.repeat(64)}\n`
          : JSON.stringify({ R: { Version: '4.4.3' }, Packages: { numpy: { Version: '1.0' } } })
      await writeFile(join(sessionRoot, filename), content)
      try {
        const result = await captureNotebookEnvironmentLock(
          {
            language,
            environmentName: 'analysis',
            runtimeSource: 'managed',
            condaPrefix: '/runtime/envs/analysis'
          },
          manifest({
            kernelKind: language,
            packages: [
              {
                name: 'numpy',
                version: '2.0',
                versionStatus: 'known',
                ecosystem: language,
                evidenceSources: [
                  language === 'python' ? 'python-importlib-metadata' : 'r-installed-packages'
                ]
              }
            ]
          }),
          {
            micromamba: '/runtime/micromamba',
            execute: async () => condaInventory(language === 'python' ? 'pip' : 'r-renv'),
            workspace: { sessionRoot, searchRoots: [sessionRoot] }
          }
        )
        expect(result).toMatchObject({
          state: 'captured',
          captureStatus: 'partial',
          partialReasons: ['non-conda-package-detected'],
          diagnostics: [
            {
              reason: 'package-version-mismatch',
              packageName: 'numpy',
              observedVersion: '2.0',
              lockedVersion: '1.0'
            }
          ]
        })
      } finally {
        await rm(sessionRoot, { recursive: true, force: true })
      }
    }
  )

  it('captures one exact lock for a fully Conda-covered Python environment', async () => {
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy'))

    await expect(
      captureNotebookEnvironmentLock(
        {
          language: 'python',
          environmentName: 'default-python',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/envs/default-python'
        },
        manifest(),
        { micromamba: '/runtime/micromamba', execute }
      )
    ).resolves.toEqual({
      state: 'captured',
      captureStatus: 'complete',
      lock: expect.objectContaining({
        schemaVersion: 1,
        format: 'environment-lock-bundle',
        components: expect.arrayContaining([
          expect.objectContaining({
            ecosystem: 'conda',
            format: 'conda-explicit-md5',
            resolution: 'locked',
            packages: ['numpy']
          })
        ])
      })
    })
    expect(execute).toHaveBeenCalledWith([
      '/runtime/micromamba',
      '--no-rc',
      'list',
      '--prefix',
      '/runtime/envs/default-python',
      '--json'
    ])
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not downgrade a managed Python lock for imported modules covered by the runtime', async () => {
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('python', 'numpy', 'matplotlib-base', 'pillow'))

    const result = await captureNotebookEnvironmentLock(
      {
        language: 'python',
        environmentName: 'default-python',
        runtimeSource: 'managed',
        condaPrefix: '/runtime/envs/default-python'
      },
      manifest({
        packages: [
          {
            name: 'NumPy',
            version: '2.3.2',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata', 'python-kernel-modules'],
            loadedState: 'loaded'
          },
          {
            name: 'matplotlib',
            version: '1.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata', 'python-kernel-modules'],
            loadedState: 'loaded'
          },
          {
            name: 'Pillow',
            version: '1.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata'],
            loadedState: 'installed-only'
          },
          {
            name: 'PIL',
            version: '1.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-kernel-modules'],
            loadedState: 'loaded'
          },
          {
            name: 'abc',
            versionStatus: 'unavailable',
            ecosystem: 'python',
            evidenceSources: ['python-kernel-modules'],
            loadedState: 'loaded'
          }
        ]
      }),
      { micromamba: '/runtime/micromamba', execute }
    )

    expect(result).toMatchObject({
      state: 'captured',
      captureStatus: 'complete'
    })
    if (result.state === 'captured') expect(result.lock).not.toHaveProperty('untrackedPackages')
  })

  it('uses the same lock envelope and marks pip packages as partial', async () => {
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy'))
    const withPip = manifest({
      packages: [
        ...manifest().packages,
        {
          name: 'scanpy',
          version: '1.11.4',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: ['python-importlib-metadata']
        }
      ],
      operationLog: [
        {
          operationId: 'install-1',
          timestamp: '2026-09-02T00:00:00.000Z',
          operation: 'install',
          packages: ['scanpy'],
          result: 'success',
          attempts: [
            {
              groupOrdinal: 0,
              installer: 'pip',
              packages: ['scanpy'],
              status: 'succeeded',
              mutationRisk: 'confirmed'
            }
          ],
          fallbackUsed: true,
          inventoryRefresh: 'published',
          inventoryRefreshAttempts: []
        }
      ]
    })

    const result = await captureNotebookEnvironmentLock(
      {
        language: 'python',
        environmentName: 'default-python',
        runtimeSource: 'managed',
        condaPrefix: '/runtime/envs/default-python'
      },
      withPip,
      { micromamba: '/runtime/micromamba', execute }
    )

    expect(result).toEqual({
      state: 'captured',
      captureStatus: 'partial',
      partialReasons: ['non-conda-package-detected', 'non-conda-installer-detected'],
      lock: expect.objectContaining({
        untrackedPackages: ['python:scanpy'],
        nonCondaInstallers: ['pip']
      }),
      diagnostics: [
        { reason: 'package-lock-missing', packageName: 'scanpy', observedVersion: '1.11.4' }
      ]
    })
  })

  it('recognizes Conda R packages while ignoring R base packages', async () => {
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('r-base', 'r-data.table'))
    const rManifest = manifest({
      kernelKind: 'r',
      environmentName: 'default-r',
      packages: [
        {
          name: 'base',
          version: '4.4.3',
          versionStatus: 'known',
          ecosystem: 'r',
          evidenceSources: ['r-installed-packages'],
          priority: 'base',
          libraryScope: 'environment'
        },
        {
          name: 'data.table',
          version: '1.17.8',
          versionStatus: 'known',
          ecosystem: 'r',
          evidenceSources: ['r-installed-packages'],
          libraryScope: 'environment'
        }
      ]
    })

    const result = await captureNotebookEnvironmentLock(
      {
        language: 'r',
        environmentName: 'default-r',
        runtimeSource: 'managed',
        condaPrefix: 'C:\\runtime\\envs\\default-r'
      },
      rManifest,
      { micromamba: 'micromamba.exe', execute }
    )

    expect(result).toEqual({
      state: 'captured',
      captureStatus: 'complete',
      lock: expect.any(Object)
    })
    if (result.state === 'captured') expect(result.lock).not.toHaveProperty('untrackedPackages')
  })

  it('preserves the Conda baseline but marks a user-library R package as partial', async () => {
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('r-base'))
    const result = await captureNotebookEnvironmentLock(
      {
        language: 'r',
        environmentName: 'default-r',
        runtimeSource: 'managed',
        condaPrefix: '/runtime/envs/default-r'
      },
      manifest({
        kernelKind: 'r',
        environmentName: 'default-r',
        packages: [
          {
            name: 'base',
            version: '4.4.3',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            priority: 'base',
            libraryScope: 'environment'
          },
          {
            name: 'ggplot2',
            version: '3.5.2',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            libraryScope: 'user'
          }
        ],
        operationLog: [
          {
            operationId: 'install-r-1',
            timestamp: '2026-09-02T00:00:00.000Z',
            operation: 'install',
            packages: ['ggplot2'],
            result: 'success',
            attempts: [
              {
                groupOrdinal: 0,
                installer: 'r-install-packages',
                packages: ['ggplot2'],
                status: 'succeeded',
                mutationRisk: 'confirmed'
              }
            ],
            fallbackUsed: true,
            inventoryRefresh: 'published',
            inventoryRefreshAttempts: []
          }
        ]
      }),
      { micromamba: '/runtime/micromamba', execute }
    )

    expect(result).toEqual({
      state: 'captured',
      captureStatus: 'partial',
      partialReasons: ['non-conda-package-detected', 'non-conda-installer-detected'],
      lock: expect.objectContaining({
        untrackedPackages: ['r:ggplot2'],
        nonCondaInstallers: ['r-install-packages']
      }),
      diagnostics: [
        { reason: 'package-lock-missing', packageName: 'ggplot2', observedVersion: '3.5.2' }
      ]
    })
  })

  it('freezes safe uv, Poetry, and hashed pip project locks from the run workspace', async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-python-locks-'))
    const cwd = join(sessionRoot, 'data')
    await mkdir(cwd)
    await Promise.all([
      writeFile(join(cwd, 'uv.lock'), 'version = 1\n[[package]]\nname = "scanpy"\n'),
      writeFile(
        join(cwd, 'pyproject.toml'),
        '[project]\nname = "analysis"\ndependencies = ["scanpy==1.11.4"]\n'
      ),
      writeFile(join(cwd, 'poetry.lock'), '[[package]]\nname = "scanpy"\nversion = "1.11.4"\n'),
      writeFile(
        join(cwd, 'requirements.txt'),
        'scanpy==1.11.4 --hash=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'
      )
    ])
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy', 'pip'))

    try {
      const result = await captureNotebookEnvironmentLock(
        {
          language: 'python',
          environmentName: 'default-python',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/envs/default-python'
        },
        manifest({
          packages: [
            ...manifest().packages,
            {
              name: 'scanpy',
              version: '1.11.4',
              versionStatus: 'known',
              ecosystem: 'python',
              evidenceSources: ['python-importlib-metadata']
            }
          ]
        }),
        {
          micromamba: '/runtime/micromamba',
          execute,
          workspace: { sessionRoot, searchRoots: [cwd, sessionRoot] }
        }
      )

      expect(result).toEqual({
        state: 'captured',
        captureStatus: 'complete',
        lock: expect.objectContaining({
          components: expect.arrayContaining([
            expect.objectContaining({
              ecosystem: 'python',
              format: 'uv-lock',
              resolution: 'locked',
              files: expect.arrayContaining([
                expect.objectContaining({ path: 'data/uv.lock' }),
                expect.objectContaining({ path: 'data/pyproject.toml' })
              ])
            }),
            expect.objectContaining({
              ecosystem: 'python',
              format: 'poetry-lock',
              resolution: 'locked'
            }),
            expect.objectContaining({
              ecosystem: 'python',
              format: 'pip-requirements',
              resolution: 'locked',
              files: [expect.objectContaining({ path: 'data/requirements.txt' })]
            })
          ])
        })
      })
    } finally {
      await rm(sessionRoot, { recursive: true, force: true })
    }
  })

  it('freezes renv and pak locks while package operation evidence remains in the manifest', async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-r-lock-'))
    const cwd = join(sessionRoot, 'data')
    await mkdir(cwd)
    await writeFile(
      join(cwd, 'renv.lock'),
      `${JSON.stringify({ R: { Version: '4.4.3' }, Bioconductor: { Version: '3.20' }, Packages: { DESeq2: { Version: '1.44.0', Source: 'Bioconductor' } } }, null, 2)}\n`
    )
    await writeFile(
      join(cwd, 'pkg.lock'),
      `${JSON.stringify(
        {
          lockfile_version: 1,
          packages: [
            {
              package: 'DESeq2',
              version: '1.44.0',
              remote: 'https://bioconductor.org/packages/3.20/bioc/src/contrib/DESeq2_1.44.0.tar.gz'
            }
          ]
        },
        null,
        2
      )}\n`
    )
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('r-base', 'r-renv'))

    try {
      const result = await captureNotebookEnvironmentLock(
        {
          language: 'r',
          environmentName: 'default-r',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/envs/default-r'
        },
        manifest({
          kernelKind: 'r',
          environmentName: 'default-r',
          packages: [
            {
              name: 'DESeq2',
              version: '1.44.0',
              versionStatus: 'known',
              ecosystem: 'r',
              evidenceSources: ['r-installed-packages'],
              source: { type: 'bioconductor', version: '3.20' }
            }
          ]
        }),
        {
          micromamba: '/runtime/micromamba',
          execute,
          workspace: { sessionRoot, searchRoots: [cwd] }
        }
      )

      expect(result).toEqual({
        state: 'captured',
        captureStatus: 'complete',
        lock: expect.objectContaining({
          components: expect.arrayContaining([
            expect.objectContaining({
              ecosystem: 'r',
              format: 'renv-lock',
              resolution: 'locked',
              files: [expect.objectContaining({ path: 'data/renv.lock' })]
            }),
            expect.objectContaining({
              ecosystem: 'r',
              format: 'pak-lock',
              resolution: 'locked',
              files: [expect.objectContaining({ path: 'data/pkg.lock' })]
            })
          ])
        })
      })
    } finally {
      await rm(sessionRoot, { recursive: true, force: true })
    }
  })

  it('retains an ordinary pip requirements file as best-effort evidence', async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-pip-evidence-'))
    const cwd = join(sessionRoot, 'data', 'nested')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(sessionRoot, 'data', 'requirements.txt'), 'scanpy==1.11.4\n')
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy'))

    try {
      const result = await captureNotebookEnvironmentLock(
        {
          language: 'python',
          environmentName: 'default-python',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/envs/default-python'
        },
        manifest(),
        {
          micromamba: '/runtime/micromamba',
          execute,
          workspace: { sessionRoot, searchRoots: [cwd] }
        }
      )

      expect(result).toEqual({
        state: 'captured',
        captureStatus: 'partial',
        partialReasons: ['native-lock-file-best-effort'],
        lock: expect.objectContaining({
          components: expect.arrayContaining([
            expect.objectContaining({
              ecosystem: 'python',
              format: 'pip-requirements',
              resolution: 'best-effort',
              files: [expect.objectContaining({ path: 'data/requirements.txt' })]
            })
          ])
        })
      })
    } finally {
      await rm(sessionRoot, { recursive: true, force: true })
    }
  })

  it('rejects secret-bearing and symlinked native lockfiles without losing the Conda lock', async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-unsafe-lock-'))
    const cwd = join(sessionRoot, 'data')
    await mkdir(cwd)
    await writeFile(
      join(cwd, 'requirements.txt'),
      'private-package @ https://user:secret@example.test/private.whl\n'
    )
    await writeFile(join(sessionRoot, 'outside.lock'), 'version = 1\n')
    await symlink(join(sessionRoot, 'outside.lock'), join(cwd, 'uv.lock'))
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy'))

    try {
      const result = await captureNotebookEnvironmentLock(
        {
          language: 'python',
          environmentName: 'default-python',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/envs/default-python'
        },
        manifest(),
        {
          micromamba: '/runtime/micromamba',
          execute,
          workspace: { sessionRoot, searchRoots: [cwd] }
        }
      )

      expect(result).toEqual({
        state: 'captured',
        captureStatus: 'partial',
        partialReasons: ['native-lock-file-rejected'],
        lock: expect.any(Object)
      })
      if (result.state === 'captured') {
        expect(result.lock.components).toHaveLength(1)
      }
    } finally {
      await rm(sessionRoot, { recursive: true, force: true })
    }
  })

  it('rejects native lockfiles that depend on absolute host paths', async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-host-path-lock-'))
    const cwd = join(sessionRoot, 'data')
    await mkdir(cwd)
    await writeFile(
      join(cwd, 'requirements.txt'),
      'local-analysis @ /opt/research/local-analysis\n'
    )
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy'))

    try {
      const result = await captureNotebookEnvironmentLock(
        {
          language: 'python',
          environmentName: 'default-python',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/envs/default-python'
        },
        manifest(),
        {
          micromamba: '/runtime/micromamba',
          execute,
          workspace: { sessionRoot, searchRoots: [cwd] }
        }
      )

      expect(result).toEqual({
        state: 'captured',
        captureStatus: 'partial',
        partialReasons: ['native-lock-file-rejected'],
        lock: expect.any(Object)
      })
      if (result.state === 'captured') expect(result.lock.components).toHaveLength(1)
    } finally {
      await rm(sessionRoot, { recursive: true, force: true })
    }
  })

  it('rejects relative local package dependencies instead of persisting host-bound paths', async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-local-path-lock-'))
    const cwd = join(sessionRoot, 'data')
    await mkdir(cwd)
    await Promise.all([
      writeFile(join(cwd, 'uv.lock'), 'version = 1\n[[package]]\nname = "analysis"\n'),
      writeFile(
        join(cwd, 'pyproject.toml'),
        '[tool.poetry.dependencies]\nlocal-analysis = { path = "../local-analysis" }\n'
      ),
      writeFile(join(cwd, 'requirements.txt'), '-e ../local-analysis\n')
    ])
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy'))

    try {
      const result = await captureNotebookEnvironmentLock(
        {
          language: 'python',
          environmentName: 'default-python',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/envs/default-python'
        },
        manifest(),
        {
          micromamba: '/runtime/micromamba',
          execute,
          workspace: { sessionRoot, searchRoots: [cwd] }
        }
      )

      expect(result).toEqual({
        state: 'captured',
        captureStatus: 'partial',
        partialReasons: ['native-lock-file-rejected'],
        lock: expect.any(Object)
      })
      if (result.state === 'captured') expect(result.lock.components).toHaveLength(1)
    } finally {
      await rm(sessionRoot, { recursive: true, force: true })
    }
  })

  it('rejects a bare Windows-relative package dependency', async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-windows-path-lock-'))
    const cwd = join(sessionRoot, 'data')
    await mkdir(cwd)
    await writeFile(join(cwd, 'requirements.txt'), '..\\local-analysis\n')
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy'))

    try {
      const result = await captureNotebookEnvironmentLock(
        {
          language: 'python',
          environmentName: 'default-python',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/envs/default-python'
        },
        manifest(),
        {
          micromamba: '/runtime/micromamba',
          execute,
          workspace: { sessionRoot, searchRoots: [cwd] }
        }
      )

      expect(result).toEqual({
        state: 'captured',
        captureStatus: 'partial',
        partialReasons: ['native-lock-file-rejected'],
        lock: expect.any(Object)
      })
      if (result.state === 'captured') expect(result.lock.components).toHaveLength(1)
    } finally {
      await rm(sessionRoot, { recursive: true, force: true })
    }
  })

  it('does not claim absent native or unknown inventory entries are covered by Conda', async () => {
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy'))
    const result = await captureNotebookEnvironmentLock(
      {
        language: 'python',
        environmentName: 'default-python',
        runtimeSource: 'managed',
        condaPrefix: '/runtime/envs/default-python'
      },
      manifest({
        packages: [
          ...manifest().packages,
          {
            name: 'openssl',
            version: '3.5.0',
            versionStatus: 'known',
            ecosystem: 'native',
            evidenceSources: ['python-kernel-modules']
          },
          {
            name: 'custom-runtime',
            versionStatus: 'unavailable',
            ecosystem: 'unknown',
            evidenceSources: ['python-kernel-modules']
          }
        ]
      }),
      { micromamba: '/runtime/micromamba', execute }
    )

    expect(result).toEqual({
      state: 'captured',
      captureStatus: 'partial',
      partialReasons: ['non-conda-package-detected'],
      lock: expect.objectContaining({
        untrackedPackages: ['native:openssl', 'unknown:custom-runtime']
      })
    })
  })

  it('reuses an unchanged environment revision and invalidates on lock, Conda, or fingerprint changes', async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'open-science-lock-cache-'))
    const condaPrefix = join(sessionRoot, 'runtime', 'envs', 'default-python')
    const cwd = join(sessionRoot, 'data')
    await Promise.all([mkdir(join(condaPrefix, 'conda-meta'), { recursive: true }), mkdir(cwd)])
    await writeFile(join(condaPrefix, 'conda-meta', 'history'), 'initial\n')
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy'))
    const owner = new EnvironmentLockCaptureOwner()
    const target = {
      language: 'python' as const,
      environmentName: 'default-python',
      runtimeSource: 'managed' as const,
      condaPrefix
    }
    const options = {
      micromamba: '/runtime/micromamba',
      execute,
      environmentFingerprint: 'fingerprint-a',
      workspace: { sessionRoot, searchRoots: [cwd] }
    }

    try {
      const first = await owner.capture(target, manifest(), options)
      const sameRevision = await owner.capture(
        target,
        manifest({ capturedAt: '2026-09-02T00:01:00.000Z' }),
        options
      )
      expect(execute).toHaveBeenCalledTimes(1)
      expect(sameRevision).toEqual(first)
      if (first.state !== 'captured') throw new Error('Expected a lock.')
      expect(first.lock).not.toHaveProperty('capturedAt')
      expect(first.lock).not.toHaveProperty('environmentManifestChecksum')

      const partialManifest = await owner.capture(
        target,
        manifest({ complete: false, captureStatus: 'partial' }),
        options
      )
      expect(execute).toHaveBeenCalledTimes(2)
      expect(partialManifest).toMatchObject({
        state: 'captured',
        captureStatus: 'partial',
        partialReasons: ['environment-manifest-partial']
      })
      if (partialManifest.state !== 'captured') throw new Error('Expected a lock.')
      expect(partialManifest.lock).toEqual(first.lock)

      await writeFile(join(cwd, 'requirements.txt'), 'scanpy==1.11.4\n')
      await owner.capture(target, manifest(), options)
      expect(execute).toHaveBeenCalledTimes(3)

      await writeFile(join(condaPrefix, 'conda-meta', 'history'), 'changed\n')
      await owner.capture(target, manifest(), options)
      expect(execute).toHaveBeenCalledTimes(4)

      await owner.capture(target, manifest(), {
        ...options,
        environmentFingerprint: 'fingerprint-b'
      })
      expect(execute).toHaveBeenCalledTimes(5)
    } finally {
      await rm(sessionRoot, { recursive: true, force: true })
    }
  })

  it('fails closed for external runtimes, missing micromamba, and unsafe URLs', async () => {
    const execute = vi.fn<(argv: string[]) => Promise<string>>()
    await expect(
      captureNotebookEnvironmentLock(
        { language: 'python', environmentName: 'external', runtimeSource: 'external' },
        manifest(),
        { micromamba: '/runtime/micromamba', execute }
      )
    ).resolves.toEqual({ state: 'unavailable', reason: 'environment-not-managed' })
    await expect(
      captureNotebookEnvironmentLock(
        {
          language: 'python',
          environmentName: 'default-python',
          runtimeSource: 'managed',
          condaPrefix: '/runtime/envs/default-python'
        },
        manifest(),
        { execute }
      )
    ).resolves.toEqual({ state: 'unavailable', reason: 'micromamba-unavailable' })

    expect(() =>
      validateExplicitLock(
        'https://token@conda.example/osx-arm64/numpy.conda#0123456789abcdef0123456789abcdef'
      )
    ).toThrow(/unsafe/u)
  })
})

describe('parseCondaPackageNames', () => {
  it('excludes PyPI records without accepting incomplete Conda archives', () => {
    const baseline = JSON.parse(condaInventory('python'))
    const native = { name: 'pandas', version: '3.0.5', channel: 'pypi', url: '', md5: '' }
    expect(parseCondaPackageNames(JSON.stringify([...baseline, native]))).toEqual(['python'])
    expect(() =>
      parseCondaPackageNames(JSON.stringify([...baseline, { ...native, channel: 'conda-forge' }]))
    ).toThrow(/not restorable/u)
    expect(() => parseCondaPackageNames(JSON.stringify([native]))).toThrow(/no packages/u)
    expect(() =>
      parseCondaPackageNames(JSON.stringify([...baseline, { ...native, version: '' }]))
    ).toThrow(/invalid/u)
  })

  it('normalizes package identity differences shared by Python and R', () => {
    expect(parseCondaPackageNames(condaInventory('Data_Table', 'python-dateutil'))).toEqual([
      'data-table',
      'python-dateutil'
    ])
  })
})

describe('decodeNotebookEnvironmentLock', () => {
  it.each(['python', 'r'] as const)(
    'rejects conflicting archive entries in an imported %s lock',
    (kernelKind) => {
      const file = kernelKind === 'python' ? 'python-3.12.0-0.conda' : 'r-base-4.4.3-0.conda'
      const explicitLock =
        `@EXPLICIT\nhttps://conda.example/${file}#${'a'.repeat(32)}\n` +
        `https://mirror.example/${file}#${'b'.repeat(32)}\n`
      expect(
        decodeNotebookEnvironmentLock(
          JSON.stringify({
            schemaVersion: 1,
            format: 'environment-lock-bundle',
            kernelKind,
            environmentName: `default-${kernelKind}`,
            components: [
              {
                ecosystem: 'conda',
                format: 'conda-explicit-md5',
                resolution: 'locked',
                explicitLock,
                packages: [kernelKind === 'r' ? 'r-base' : 'python']
              }
            ]
          })
        ).status
      ).toBe('corrupt')
    }
  )
  it.each(['renv-lock', 'pak-lock'] as const)(
    'finds %s by filename independently of attachment order',
    (format) => {
      const primary = lockFile(
        format === 'renv-lock' ? 'renv.lock' : 'pkg.lock',
        JSON.stringify(
          format === 'renv-lock'
            ? { Packages: { analysis: { Version: '1.0' } } }
            : { packages: [{ package: 'analysis', version: '1.0' }] }
        )
      )
      const companion = lockFile('settings.json', '{}')
      const bundle = (files: (typeof primary)[]): string =>
        JSON.stringify({
          schemaVersion: 1,
          format: 'environment-lock-bundle',
          kernelKind: 'r',
          environmentName: 'default-r',
          components: [
            {
              ecosystem: 'conda',
              format: 'conda-explicit-md5',
              resolution: 'locked',
              explicitLock:
                '@EXPLICIT\nhttps://conda.example/r-base.conda#' + 'a'.repeat(32) + '\n',
              packages: ['r-base']
            },
            { ecosystem: 'r', format, resolution: 'locked', files }
          ]
        })
      expect(decodeNotebookEnvironmentLock(bundle([primary, companion])).status).toBe('valid')
      expect(decodeNotebookEnvironmentLock(bundle([companion, primary])).status).toBe('valid')
      expect(
        decodeNotebookEnvironmentLock(
          bundle([primary, { ...primary, path: 'other/' + primary.path }])
        ).status
      ).toBe('corrupt')
    }
  )
  it('accepts the exact v1 shape and rejects unknown or inconsistent fields', async () => {
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy'))
    const captured = await captureNotebookEnvironmentLock(
      {
        language: 'python',
        environmentName: 'default-python',
        runtimeSource: 'managed',
        condaPrefix: '/runtime/envs/default-python'
      },
      manifest(),
      { micromamba: '/runtime/micromamba', execute }
    )
    if (captured.state !== 'captured') throw new Error('Expected a lock.')

    expect(decodeNotebookEnvironmentLock(JSON.stringify(captured.lock)).status).toBe('valid')
    expect(
      decodeNotebookEnvironmentLock(JSON.stringify({ ...captured.lock, unknown: true }))
    ).toEqual({ status: 'corrupt' })
    const conda = captured.lock.components[0]
    if (!conda || conda.ecosystem !== 'conda') throw new Error('Expected a Conda lock component.')
    expect(
      decodeNotebookEnvironmentLock(
        JSON.stringify({
          ...captured.lock,
          components: [{ ...conda, packages: [], unknown: true }]
        })
      )
    ).toEqual({ status: 'corrupt' })
    expect(
      decodeNotebookEnvironmentLock(
        JSON.stringify({ ...captured.lock, components: [conda, conda] })
      )
    ).toEqual({ status: 'corrupt' })
    expect(
      decodeNotebookEnvironmentLock(JSON.stringify({ ...captured.lock, capturedAt: 'unexpected' }))
    ).toEqual({ status: 'corrupt' })
  })

  it('rejects native components that merely claim exact restoration', async () => {
    const execute = vi
      .fn<(argv: string[]) => Promise<string>>()
      .mockResolvedValue(condaInventory('numpy', 'pip', 'uv'))
    const captured = await captureNotebookEnvironmentLock(
      {
        language: 'python',
        environmentName: 'default-python',
        runtimeSource: 'managed',
        condaPrefix: '/runtime/envs/default-python'
      },
      manifest(),
      { micromamba: '/runtime/micromamba', execute }
    )
    if (captured.state !== 'captured') throw new Error('Expected a lock.')
    const conda = captured.lock.components[0]
    if (!conda || conda.ecosystem !== 'conda') throw new Error('Expected a Conda lock component.')

    const forgedPip = {
      ...captured.lock,
      components: [
        conda,
        {
          ecosystem: 'python',
          format: 'pip-requirements',
          resolution: 'locked',
          files: [
            lockFile(
              'requirements.txt',
              `--extra-index-url https://packages.example.test/simple\nnumpy==2.0 --hash=sha256:${'1'.repeat(64)}\n`
            )
          ]
        }
      ]
    }
    expect(decodeNotebookEnvironmentLock(JSON.stringify(forgedPip))).toEqual({
      status: 'corrupt'
    })
    const pinned = `numpy==2.0 --hash=sha256:${'1'.repeat(64)}\n`
    for (const files of [
      [lockFile('requirements.lock', pinned.replace('2.0', '2.*'))],
      [
        lockFile('requirements.lock', pinned),
        lockFile('other/requirements.lock', pinned),
        lockFile('requirements.txt', pinned)
      ]
    ]) {
      expect(
        decodeNotebookEnvironmentLock(
          JSON.stringify({
            ...captured.lock,
            components: [
              conda,
              {
                ecosystem: 'python',
                format: 'pip-requirements',
                resolution: 'locked',
                files
              }
            ]
          })
        ).status
      ).toBe('corrupt')
    }

    const uvLock = 'version = 1\n[[package]]\nname = "numpy"\n'
    const forgedUv = {
      ...captured.lock,
      components: [
        conda,
        {
          ecosystem: 'python',
          format: 'uv-lock',
          resolution: 'locked',
          files: [
            lockFile('project/uv.lock', uvLock),
            lockFile('elsewhere/pyproject.toml', '[project]\nname = "analysis"\n')
          ]
        }
      ]
    }
    expect(decodeNotebookEnvironmentLock(JSON.stringify(forgedUv))).toEqual({
      status: 'corrupt'
    })
  })
})
