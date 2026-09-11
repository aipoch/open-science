import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32, posix } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ArtifactProvenanceGraph,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import type {
  NotebookEnvironmentPackage,
  NotebookPackageInstallerAttempt
} from '../../shared/notebook'
import {
  prepareArtifactReproducibilityExecutionPlan,
  sealArtifactReproducibilityRecipe
} from '../artifacts/artifact-reproducibility-recipe'
import { environmentCaptureProcessEnv, EnvironmentStateTracker } from './environment-state-tracker'

let dataRoot: string | undefined

afterEach(async () => {
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
  dataRoot = undefined
})

const target = {
  language: 'python' as const,
  environmentName: 'external-analysis',
  runtimeSource: 'external' as const,
  command: '/opt/python/bin/python',
  args: []
}

const bindingPath = async (root: string): Promise<string> => {
  const inventoryRoot = join(root, 'runtime', 'provenance', 'environment-inventory')
  const [targetKey] = await readdir(inventoryRoot)
  return join(inventoryRoot, targetKey, 'binding.json')
}

const readBinding = async (
  root: string
): Promise<{
  operationLog: Array<{ operationId: string; timestamp: string }>
  operationLogTruncation?: { omittedCount: number; earliestRetainedAt?: string }
  dirtyOperationId?: string
}> => {
  return JSON.parse(await readFile(await bindingPath(root), 'utf8'))
}

describe('EnvironmentStateTracker', () => {
  it.each(['win32', 'darwin', 'linux'] as const)(
    'isolates fresh managed Python/R metadata from host libraries on %s',
    async (platform) => {
      const path = platform === 'win32' ? win32 : posix
      const root = platform === 'win32' ? 'C:\\runtime-test' : '/runtime-test'
      const condaPrefix = path.join(root, 'envs', 'analysis')
      vi.stubEnv('PYTHONPATH', '/host-only-python')
      vi.stubEnv('PYTHONNOUSERSITE', '0')
      vi.stubEnv('R_LIBS', '/host-only-r')
      vi.stubEnv('R_LIBS_USER', '/host-user-r')
      vi.stubEnv('R_LIBS_SITE', '/host-site-r')
      try {
        const execute = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
        const tracker = new EnvironmentStateTracker({ dataRoot: root, platform, execFile: execute })
        for (const language of ['python', 'r'] as const) {
          await tracker.inspectPackages(
            { ...target, language, runtimeSource: 'managed', condaPrefix },
            ['numpy'],
            { fresh: true }
          )
          const [, args, options] = execute.mock.calls.at(-1)!
          expect(options.env.HOME).toBe(path.join(join(root, 'runtime'), 'home'))
          if (language === 'python') {
            expect(options.env.PYTHONPATH).toBeUndefined()
            expect(options.env.PYTHONNOUSERSITE).toBe('1')
            expect(args).toContain('-I')
          } else {
            expect(options.env.R_LIBS).toBeUndefined()
            expect(options.env.R_LIBS_SITE).toBeUndefined()
            expect(options.env.R_LIBS_USER).toBe(
              join(condaPrefix, platform === 'win32' ? 'Lib' : 'lib', 'R', 'library')
            )
          }
        }
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )
  it.each(['python', 'r'] as const)(
    'fresh %s inspection bypasses cache and does not publish state',
    async (language) => {
      dataRoot = await mkdtemp(join(tmpdir(), 'fresh-package-inspection-'))
      const name = language === 'python' ? 'scikit-learn' : 'R.utils'
      const requested = language === 'python' ? 'scikit_learn' : name
      const inspectInstalled = vi.fn().mockResolvedValue({
        packages: [
          {
            name,
            ecosystem: language,
            version: '1.0',
            versionStatus: 'known',
            evidenceSources: []
          }
        ]
      })
      const captureFingerprint = vi.fn()
      const resolveMicromamba = vi.fn()
      const tracker = new EnvironmentStateTracker({
        dataRoot,
        inspectInstalled,
        captureFingerprint,
        resolveMicromamba
      })
      const capture = { ...target, language, runtimeSource: 'managed' as const }
      expect(
        (await tracker.inspectPackages(capture, [requested], { fresh: true })).packages[0]
      ).toMatchObject({ status: 'installed', version: '1.0' })
      inspectInstalled.mockResolvedValue({ packages: [] })
      expect(
        (await tracker.inspectPackages(capture, [requested], { fresh: true })).packages[0].status
      ).toBe('missing')
      expect(inspectInstalled).toHaveBeenCalledTimes(2)
      expect(captureFingerprint).not.toHaveBeenCalled()
      expect(resolveMicromamba).not.toHaveBeenCalled()
      expect(await readdir(dataRoot)).toEqual([])
    }
  )

  it('does not certify conflicting Python distribution versions', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'ambiguous-python-inspection-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: async () => ({
        packages: ['1.0', '2.0'].map((version) => ({
          name: 'numpy',
          version,
          versionStatus: 'known' as const,
          ecosystem: 'python' as const,
          evidenceSources: []
        }))
      })
    })
    expect(
      (await tracker.inspectPackages(target, ['numpy==2.0'], { fresh: true })).packages[0].status
    ).toBe('unknown')
  })

  it('uses exact R names and the first library rank during fresh inspection', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'ranked-r-inspection-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: async () => ({
        packages: [2, 1].map((libraryRank) => ({
          name: 'R.utils',
          version: `${libraryRank}.0`,
          libraryRank,
          versionStatus: 'known' as const,
          ecosystem: 'r' as const,
          evidenceSources: []
        }))
      })
    })
    const result = await tracker.inspectPackages(
      { ...target, language: 'r' },
      ['R.utils', 'r.utils', 'R-utils'],
      { fresh: true }
    )
    expect(result.packages[0]).toMatchObject({
      status: 'installed',
      version: '1.0',
      libraryRank: 1
    })
    expect(result.packages[1].status).toBe('missing')
    expect(result.packages[2].status).toBe('missing')
  })

  it.each([
    { language: 'r', requested: 'org.Hs.eg.db', names: ['org.Hs.eg.db'], matched: true },
    { language: 'r', requested: 'org.hs.eg.db', names: ['org.Hs.eg.db'], matched: false },
    { language: 'r', requested: 'org..Hs.eg.db', names: ['org.Hs.eg.db'], matched: false },
    {
      language: 'r',
      requested: 'bioconductor-org.hs.eg.db',
      names: ['org.Hs.eg.db'],
      matched: true
    },
    {
      language: 'r',
      requested: 'bioconductor-org-hs-eg-db',
      names: ['org.Hs.eg.db'],
      matched: false
    },
    { language: 'r', requested: 'r-r.utils', names: ['R.utils'], matched: true },
    { language: 'r', requested: 'r-r.utils', names: ['R.utils', 'r.utils'], matched: false },
    { language: 'python', requested: 'scikit_learn', names: ['scikit-learn'], matched: true }
  ] as const)(
    'checks $language package identity for $requested against $names',
    async ({ language, requested, names, matched }) => {
      dataRoot = await mkdtemp(join(tmpdir(), 'package-request-identity-'))
      const packages: NotebookEnvironmentPackage[] = names.map((name) => ({
        name,
        version: '1.0',
        versionStatus: 'known',
        ecosystem: language,
        evidenceSources: [language === 'r' ? 'r-installed-packages' : 'python-importlib-metadata']
      }))
      const tracker = new EnvironmentStateTracker({
        dataRoot,
        inspectInstalled: vi
          .fn()
          .mockResolvedValueOnce({ packages: [] })
          .mockResolvedValue({ packages }),
        captureFingerprint: vi.fn().mockResolvedValue('stable')
      })
      const captureTarget = { ...target, language }
      await tracker.markPackageMutationDirty(captureTarget, {
        operationId: 'install-identity',
        operation: 'install',
        packages: [requested]
      })
      const result = await tracker.refreshAfterPackageMutation(captureTarget, {
        operationId: 'install-identity',
        operation: 'install',
        packages: [requested],
        result: 'success'
      })
      expect(result.result).toBe(matched ? 'success' : 'failure')
      expect(result.packageChanges).toHaveLength(names.length)
      expect(
        result.packageChanges?.every(
          (change) => change.relationship === (matched ? 'requested' : 'unattributed')
        )
      ).toBe(true)
      const inspection = await tracker.inspectPackages(captureTarget, [requested])
      expect(inspection.packages[0].status).toBe(
        matched ? 'installed' : names.length > 1 ? 'unknown' : 'missing'
      )
    }
  )

  it('preserves distinct R package names when merging installed and loaded evidence', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'r-inventory-case-'))
    const packages: NotebookEnvironmentPackage[] = ['R.utils', 'r.utils'].map((name, index) => ({
      name,
      version: `${index + 1}.0`,
      versionStatus: 'known',
      ecosystem: 'r',
      evidenceSources: ['r-installed-packages'],
      libraryRank: 1,
      libraryScope: 'environment'
    }))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({ packages }),
      captureFingerprint: vi.fn().mockResolvedValue('stable')
    })
    const capture = await tracker.captureCompletedRun(
      { ...target, language: 'r' },
      {
        packages: [{ ...packages[0], loadedState: 'loaded', evidenceSources: ['r-session-info'] }]
      }
    )
    expect(capture.manifest.packages).toHaveLength(2)
    expect(capture.manifest.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'R.utils', version: '1.0', loadedState: 'loaded' }),
        expect.objectContaining({ name: 'r.utils', version: '2.0', loadedState: 'installed-only' })
      ])
    )
  })

  it.each([
    {
      requested: 'rcolorbrewer',
      operation: 'install',
      fallback: false,
      recover: false,
      expected: 'success'
    },
    {
      requested: 'rcolorbrewer',
      operation: 'uninstall',
      fallback: false,
      recover: false,
      expected: 'failure'
    },
    {
      requested: 'rcolorbrewer',
      operation: 'install',
      fallback: true,
      recover: false,
      expected: 'failure'
    },
    {
      requested: 'rcolorbrewer',
      operation: 'install',
      fallback: false,
      recover: true,
      expected: 'success'
    },
    {
      requested: 'r-rcolorbrewer',
      operation: 'install',
      fallback: true,
      recover: false,
      expected: 'failure'
    },
    {
      requested: 'r-rcolorbrewer',
      operation: 'uninstall',
      fallback: true,
      recover: false,
      expected: 'failure'
    }
  ] as const)(
    'uses actual R installer attempts for $operation (fallback: $fallback, recovery: $recover)',
    async ({ requested, operation, fallback, recover, expected }) => {
      dataRoot = await mkdtemp(join(tmpdir(), 'r-installer-name-'))
      const packages: NotebookEnvironmentPackage[] = [
        {
          name: 'RColorBrewer',
          version: '1.1-3',
          versionStatus: 'known',
          ecosystem: 'r',
          evidenceSources: ['r-installed-packages']
        }
      ]
      const attempts: NotebookPackageInstallerAttempt[] = [
        {
          groupOrdinal: 0,
          installer: 'conda',
          packages: ['r-rcolorbrewer'],
          status: fallback ? 'failed' : 'succeeded',
          mutationRisk: 'possible'
        },
        ...(fallback
          ? [
              {
                groupOrdinal: 1,
                installer: 'r-install-packages' as const,
                packages: [requested],
                status: 'succeeded' as const,
                mutationRisk: 'possible' as const
              }
            ]
          : [])
      ]
      const inspectInstalled = vi.fn().mockResolvedValueOnce({ packages: [] })
      if (recover) inspectInstalled.mockRejectedValueOnce(new Error('refresh interrupted'))
      inspectInstalled.mockResolvedValue({ packages })
      const options = {
        dataRoot,
        inspectInstalled,
        captureFingerprint: vi.fn().mockResolvedValue('stable')
      }
      const tracker = new EnvironmentStateTracker(options)
      const captureTarget = { ...target, language: 'r' as const }
      await tracker.markPackageMutationDirty(captureTarget, {
        operationId: 'actual-installer',
        operation,
        packages: [requested]
      })
      const result = await tracker.refreshAfterPackageMutation(captureTarget, {
        operationId: 'actual-installer',
        operation,
        packages: [requested],
        attempts,
        result: 'success'
      })
      if (recover) {
        expect(result.reason).toBe('inventory-refresh-failed')
        await new EnvironmentStateTracker(options).prepareRun(captureTarget)
      } else {
        expect(result.result).toBe(expected)
      }
      const capture = await tracker.captureCompletedRun(captureTarget)
      expect(capture.manifest.operationLog?.[0]).toMatchObject({
        result: expected,
        packageChanges: [
          expect.objectContaining({
            name: 'RColorBrewer',
            relationship: fallback ? 'unattributed' : 'requested'
          })
        ]
      })
    }
  )

  it.each([
    { requested: 'R.utils', names: ['r.utils'], result: 'success' },
    { requested: 'R.utils', names: ['R.utils', 'r.utils'], result: 'failure' },
    { requested: 'r-r.utils', names: ['R.utils', 'r.utils'], result: 'failure' }
  ])(
    'verifies removal of $requested without confusing remaining R names',
    async ({ requested, names, result }) => {
      dataRoot = await mkdtemp(join(tmpdir(), 'r-removal-identity-'))
      const packages: NotebookEnvironmentPackage[] = names.map((name) => ({
        name,
        version: '1.0',
        versionStatus: 'known',
        ecosystem: 'r',
        evidenceSources: ['r-installed-packages']
      }))
      const tracker = new EnvironmentStateTracker({
        dataRoot,
        inspectInstalled: vi.fn().mockResolvedValue({ packages }),
        captureFingerprint: vi.fn().mockResolvedValue('stable')
      })
      const captureTarget = { ...target, language: 'r' as const }
      await tracker.markPackageMutationDirty(captureTarget, {
        operationId: 'remove-identity',
        operation: 'uninstall',
        packages: [requested]
      })
      const verification = await tracker.refreshAfterPackageMutation(captureTarget, {
        operationId: 'remove-identity',
        operation: 'uninstall',
        packages: [requested],
        result: 'success'
      })
      expect(verification.result).toBe(result)
    }
  )

  it.each(['python', 'r'] as const)(
    'refreshes a %s inventory cached before reader revision tracking',
    async (language) => {
      dataRoot = await mkdtemp(join(tmpdir(), 'inventory-reader-revision-'))
      const fingerprintOutput = 'FILE\tunchanged\t1\t1\n'
      const probeTarget = { ...target, language }
      const before = new EnvironmentStateTracker({
        dataRoot,
        captureFingerprint: async () =>
          createHash('sha256').update(`${language}\n${fingerprintOutput}`).digest('hex'),
        inspectInstalled: async () => ({ packages: [] })
      })
      await before.prepareRun(probeTarget)
      const inspectInstalled = vi.fn(async () => ({ packages: [] }))
      const current = new EnvironmentStateTracker({
        dataRoot,
        inspectInstalled,
        execFile: async () => ({ stdout: fingerprintOutput, stderr: '' })
      })
      expect((await current.prepareRun(probeTarget)).inventoryRefreshed).toBe(true)
      expect((await current.prepareRun(probeTarget)).inventoryRefreshed).toBe(false)
      expect(inspectInstalled).toHaveBeenCalledOnce()
    }
  )

  it.each([false, true])(
    'preserves conflicting live Python versions regardless of observation order (%s)',
    async (reverse) => {
      dataRoot = await mkdtemp(join(tmpdir(), 'python-live-version-'))
      const packageRow = (
        version: string,
        loadedState: 'loaded' | 'installed-only'
      ): NotebookEnvironmentPackage => ({
        name: 'extra-distribution',
        version,
        ecosystem: 'python',
        versionStatus: 'known',
        evidenceSources: ['python-kernel-modules', 'python-importlib-metadata'],
        loadedState
      })
      const tracker = new EnvironmentStateTracker({
        dataRoot,
        captureFingerprint: async () => 'stable',
        inspectInstalled: async () => ({
          packages: [
            {
              ...packageRow('99.0', 'installed-only'),
              evidenceSources: ['python-importlib-metadata']
            }
          ]
        })
      })
      const packages = [packageRow('1.0', 'loaded'), packageRow('99.0', 'installed-only')]
      const captured = await tracker.captureCompletedRun(target, {
        packages: reverse ? packages.reverse() : packages
      })
      expect(captured.manifest.packages).toContainEqual(
        expect.objectContaining({
          version: '1.0',
          loadedState: 'loaded'
        })
      )
      expect(captured.manifest.packages).toContainEqual(
        expect.objectContaining({
          version: '99.0',
          loadedState: 'installed-only'
        })
      )
    }
  )

  for (const language of ['python', 'r'] as const) {
    const command =
      language === 'python'
        ? process.env.OPEN_SCIENCE_TEST_PYTHON
        : process.env.OPEN_SCIENCE_TEST_R_ENV
          ? join(process.env.OPEN_SCIENCE_TEST_R_ENV, 'bin', 'Rscript')
          : undefined
    it.skipIf(!command)(
      `invalidates the ${language} inventory when only library precedence changes`,
      async () => {
        dataRoot = await mkdtemp(join(tmpdir(), 'environment-path-order-'))
        const first = join(dataRoot, 'first')
        const second = join(dataRoot, 'second')
        await mkdir(first)
        await mkdir(second)
        let libraries = [first, second]
        const inspectInstalled = vi.fn(async () => ({ packages: [] }))
        const execute = promisify(execFile)
        const tracker = new EnvironmentStateTracker({
          dataRoot,
          inspectInstalled,
          execFile: async (executable, args, options) => {
            const setup =
              language === 'python'
                ? `import sys\nsys.path[:0] = ${JSON.stringify(libraries)}\n`
                : `.libPaths(c(${libraries.map((path) => JSON.stringify(path)).join(',')}, .libPaths()))\n`
            return execute(
              executable,
              [...args.slice(0, -1), setup + args[args.length - 1]],
              options
            )
          }
        })
        const probeTarget = {
          ...target,
          language,
          command: command!
        }
        const initial = await tracker.prepareRun(probeTarget)
        expect(initial.fingerprint).toBeTruthy()
        expect(initial.inventoryRefreshed).toBe(true)
        const unchanged = await tracker.prepareRun(probeTarget)
        expect(unchanged.fingerprint).toBe(initial.fingerprint)
        expect(unchanged.inventoryRefreshed).toBe(false)

        libraries = [second, first]
        const reordered = await tracker.prepareRun(probeTarget)
        expect(reordered.fingerprint).not.toBe(initial.fingerprint)
        expect(reordered.inventoryRefreshed).toBe(true)
        expect(inspectInstalled).toHaveBeenCalledTimes(2)
      }
    )
  }

  it('keeps a live external R library separate from the default library at the same rank', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'r-library-scope-'))
    const prefix = join(dataRoot, 'env')
    await mkdir(join(prefix, 'conda-meta'), { recursive: true })
    await writeFile(join(prefix, 'conda-meta/history'), 'baseline')
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      resolveMicromamba: async () => '/fake/micromamba',
      captureFingerprint: async () => 'stable',
      inspectInstalled: async () => ({
        packages: [
          {
            name: 'RColorBrewer',
            version: '1.1-3',
            ecosystem: 'r',
            versionStatus: 'known',
            evidenceSources: ['r-installed-packages'],
            libraryRank: 1,
            libraryScope: 'environment'
          }
        ]
      }),
      execFile: vi.fn(async () => ({
        stdout: JSON.stringify([
          {
            name: 'r-rcolorbrewer',
            version: '1.1_3',
            url: 'https://conda.example/r-rcolorbrewer.conda',
            md5: 'a'.repeat(32)
          }
        ]),
        stderr: ''
      }))
    })
    const capture = await tracker.captureCompletedRun(
      {
        language: 'r',
        runtimeSource: 'managed',
        environmentName: 'default-r',
        command: join(prefix, 'bin/Rscript'),
        condaPrefix: prefix
      },
      {
        packages: [
          {
            name: 'RColorBrewer',
            version: '1.1.3',
            ecosystem: 'r',
            versionStatus: 'known',
            evidenceSources: ['r-session-info'],
            libraryRank: 1,
            libraryScope: 'system',
            loadedState: 'loaded'
          }
        ]
      }
    )
    expect(capture.manifest.packages).toHaveLength(2)
    expect(capture.manifest.packages).toContainEqual(
      expect.objectContaining({
        libraryScope: 'system',
        loadedState: 'loaded',
        evidenceSources: ['r-session-info']
      })
    )
    expect(capture.environmentLock.state).toBe('partial')
  })
  it.each([
    ['pandas', 'pandas'],
    ['Extra_Package', 'extra-package'],
    ['extra.package', 'Extra-Package']
  ])(
    'retains package diagnostics and merges %s with the live %s identity',
    async (installedName, liveName) => {
      dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-diagnostics-'))
      const prefix = join(dataRoot, 'env')
      await mkdir(join(prefix, 'conda-meta'), { recursive: true })
      await writeFile(join(prefix, 'conda-meta', 'history'), 'created\n')
      const tracker = new EnvironmentStateTracker({
        dataRoot,
        resolveMicromamba: async () => '/fake/micromamba',
        execFile: vi.fn(async () => ({
          stdout: JSON.stringify([
            {
              name: 'python',
              version: '3.13.2',
              url: 'https://conda.example/python.conda',
              md5: 'a'.repeat(32)
            }
          ]),
          stderr: ''
        })),
        inspectInstalled: vi.fn().mockResolvedValue({
          runtimeVersion: '3.13.2',
          platform: 'linux',
          architecture: 'x64',
          packages: [
            {
              name: installedName,
              version: '3.0.5',
              versionStatus: 'known',
              ecosystem: 'python',
              evidenceSources: ['python-importlib-metadata']
            }
          ]
        }),
        captureFingerprint: async () => 'stable'
      })
      for (let index = 0; index < 2; index++) {
        const capture = await tracker.captureCompletedRun(
          {
            language: 'python',
            environmentName: 'analysis',
            runtimeSource: 'managed',
            command: join(prefix, 'bin', 'python'),
            condaPrefix: prefix
          },
          { runtimeVersion: '3.13.2', packages: [] }
        )
        expect(capture.environmentLock).toMatchObject({
          state: 'partial',
          diagnostics: [
            {
              reason: 'package-lock-missing',
              packageName: installedName.toLowerCase().replace(/[-_.]+/gu, '-'),
              observedVersion: '3.0.5'
            }
          ]
        })
      }
      const managedTarget = {
        language: 'python' as const,
        environmentName: 'analysis',
        runtimeSource: 'managed' as const,
        command: join(prefix, 'bin', 'python'),
        condaPrefix: prefix
      }
      const pkg: NotebookEnvironmentPackage = {
        name: liveName,
        version: '3.0.5',
        versionStatus: 'known',
        ecosystem: 'python',
        evidenceSources: ['python-importlib-metadata', 'python-kernel-modules'],
        loadedState: 'installed-only'
      }
      const scoped = await tracker.captureCompletedRun(managedTarget, {
        runtimeVersion: '3.13.2',
        packages: [pkg]
      })
      expect(scoped.manifest.packages).toHaveLength(1)
      expect(scoped.environmentLock.state).toBe('available')
      expect(scoped.manifest.packages).toContainEqual(
        expect.objectContaining({ name: liveName, loadedState: 'installed-only' })
      )
      if (scoped.environmentLock.state === 'unavailable') throw new Error('Expected captured lock')
      const stored = JSON.parse(
        await readFile(
          join(
            dataRoot,
            'runtime/provenance/environment-locks',
            scoped.environmentLock.lockChecksum + '.json'
          ),
          'utf8'
        )
      )
      expect(stored.omittedPackages).toEqual([
        `python:${liveName.toLowerCase().replace(/[-_.]+/gu, '-')}`
      ])
      const loaded = await tracker.captureCompletedRun(managedTarget, {
        runtimeVersion: '3.13.2',
        packages: [{ ...pkg, loadedState: 'loaded' }]
      })
      expect(loaded.environmentLock.state).toBe('partial')
    }
  )

  it('activates the Windows Conda DLL path when capturing a native R lock', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'r-lock-activation-'))
    const prefix = join(dataRoot, 'env')
    await mkdir(join(prefix, 'conda-meta'), { recursive: true })
    await writeFile(join(prefix, 'conda-meta/history'), 'baseline')
    const rTarget = {
      language: 'r' as const,
      runtimeSource: 'managed' as const,
      environmentName: 'default-r',
      command: join(prefix, 'bin/Rscript'),
      condaPrefix: prefix
    }
    const packages: NotebookEnvironmentPackage[] = [
      {
        name: 'custompkg',
        version: '1.0',
        ecosystem: 'r',
        versionStatus: 'known',
        evidenceSources: ['r-installed-packages'],
        libraryScope: 'environment',
        loadedState: 'loaded'
      }
    ]
    let snapshotPath: string | undefined
    const execute = vi.fn(
      async (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        if (args.includes('--vanilla')) snapshotPath = options.env?.PATH
        return {
          stdout: JSON.stringify(
            args.includes('list')
              ? ['r-base', 'r-renv'].map((name) => ({
                  name,
                  version: '1.0',
                  url: `https://conda.example/${name}.conda`,
                  md5: 'a'.repeat(32)
                }))
              : {
                  R: { Version: '4.4.3' },
                  Packages: {
                    custompkg: { Package: 'custompkg', Version: '1.0', Source: 'Repository' }
                  }
                }
          ),
          stderr: ''
        }
      }
    )
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      platform: 'win32',
      execFile: execute,
      resolveMicromamba: async () => 'micromamba',
      captureFingerprint: async () => 'stable',
      inspectInstalled: async () => ({ runtimeVersion: '4.4.3', packages })
    })
    const captured = await tracker.captureCompletedRun(rTarget, {
      runtimeVersion: '4.4.3',
      packages
    })
    expect(captured.environmentLock.state).toBe('available')
    const snapshotCall = execute.mock.calls.find(([, args]) => args.includes('--vanilla'))
    expect(snapshotCall?.[1]).toEqual([
      '--vanilla',
      '-e',
      expect.stringContaining('renv::snapshot')
    ])
    expect(snapshotPath).toBe(environmentCaptureProcessEnv(rTarget, process.env, 'win32').PATH)
  })

  it('activates the complete Windows Conda DLL path for managed R probes', () => {
    const inherited = { Path: 'C:\\Windows\\System32', KEEP_ME: 'yes' }
    const prefix = 'C:\\Users\\Helix\\OpenScience\\runtime\\envs\\.r'

    expect(
      environmentCaptureProcessEnv(
        {
          language: 'r',
          environmentName: 'default-r',
          runtimeSource: 'managed',
          command: `${prefix}\\Lib\\R\\bin\\Rscript.exe`,
          args: [],
          condaPrefix: prefix
        },
        inherited,
        'win32'
      )
    ).toEqual({
      KEEP_ME: 'yes',
      PATH: [
        prefix,
        `${prefix}\\Library\\mingw-w64\\bin`,
        `${prefix}\\Library\\usr\\bin`,
        `${prefix}\\Library\\bin`,
        `${prefix}\\Scripts`,
        `${prefix}\\bin`,
        'C:\\Windows\\System32'
      ].join(';')
    })
  })

  it.skipIf(!process.env.OPEN_SCIENCE_TEST_R_ENV).each([
    ...[undefined, 'RemoteSubdir', 'GithubSubdir'].map((field) => ({
      label: field ?? 'github-root',
      fields: [
        'RemoteType: github',
        'RemoteHost: api.github.com',
        'RemoteUsername: research',
        'RemoteRepo: monorepo',
        `RemoteSha: ${'a'.repeat(40)}`,
        'biocViews: Software',
        ...(field ? [`${field}: packages/nestedpkg`] : [])
      ],
      expected: {
        type: 'github',
        repository: 'research/monorepo',
        commit: 'a'.repeat(40),
        ...(field ? { subdirectory: 'packages/nestedpkg' } : {})
      }
    })),
    {
      label: 'bioc-release',
      fields: ['Repository: Bioconductor 3.20', 'biocViews: Software'],
      expected: { type: 'bioconductor', version: '3.20' }
    },
    {
      label: 'bioc-standard-remote',
      fields: ['RemoteType: standard', 'Repository: Bioconductor 3.20', 'biocViews: Software'],
      expected: { type: 'bioconductor', version: '3.20' }
    },
    {
      label: 'bioc-custom-remote',
      fields: ['RemoteType: gitlab', 'Repository: Bioconductor 3.20', 'biocViews: Software'],
      expected: undefined
    },
    {
      label: 'bioc-annotation-branch',
      fields: [
        'biocViews: AnnotationData',
        'git_url: https://git.bioconductor.org/packages/nestedpkg',
        'git_branch: RELEASE_3_20'
      ],
      expected: { type: 'bioconductor', version: '3.20' }
    },
    {
      label: 'bioc-experiment-unknown',
      fields: ['biocViews: ExperimentData'],
      expected: { type: 'bioconductor' }
    },
    {
      label: 'bioc-conflicting-release',
      fields: [
        'Repository: Bioconductor 3.20',
        'git_url: https://git.bioconductor.org/packages/nestedpkg',
        'git_branch: RELEASE_3_21'
      ],
      expected: { type: 'bioconductor' }
    },
    {
      label: 'untrusted-branch',
      fields: [
        'biocViews: Software',
        'git_url: https://example.org/packages/nestedpkg',
        'git_branch: RELEASE_3_20'
      ],
      expected: { type: 'bioconductor' }
    },
    { label: 'cran', fields: ['Repository: CRAN'], expected: undefined }
  ])('reads R package source metadata with real R: $label', async ({ fields, expected }) => {
    dataRoot = await mkdtemp(join(tmpdir(), 'r-source-description-'))
    const library = join(dataRoot, 'library')
    const packageRoot = join(library, 'nestedpkg')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'DESCRIPTION'),
      ['Package: nestedpkg', 'Version: 1.0', ...fields].join('\n') + '\n'
    )
    const execute = promisify(execFile)
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      execFile: async (executable, args, options) => {
        // Supply one inventory row; evaluate the production DESCRIPTION reader and TSV emitter.
        // No R package is installed or loaded from this metadata fixture.
        const setup = `installed.packages <- function(...) matrix(c("nestedpkg", "1.0", ${JSON.stringify(library)}), nrow=1, dimnames=list(NULL, c("Package", "Version", "LibPath")))\n`
        return execute(executable, [...args.slice(0, -1), setup + args[args.length - 1]], options)
      }
    })
    const inspected = await tracker.inspectPackages(
      {
        ...target,
        language: 'r',
        command: join(process.env.OPEN_SCIENCE_TEST_R_ENV!, 'bin', 'Rscript')
      },
      ['nestedpkg']
    )
    expect(inspected.packages[0]?.source).toEqual(expected)
  })

  it('passes the activated Windows Conda DLL path to default R inventory and fingerprint spawns', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-r-spawn-'))
    const prefix = 'C:\\Users\\Helix\\OpenScience\\runtime\\envs\\.r'
    const execute = vi.fn(
      async (
        _command: string,
        _args: string[],
        options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }
      ) => ({
        stdout:
          options.maxBuffer === 8 * 1024 * 1024
            ? 'FILE\tconda-meta/history\t1\t1\n'
            : 'RUNTIME\t4.5.1\twin32\tx86_64\n' +
              'PACKAGE\tggplot2\t4.0.0.9000\t\t4.5.1\t1\tenvironment\tgithub\tapi.github.com\ttidyverse\tggplot2\tmain\ta7b92f1\tpackages/ggplot2\n' +
              'PACKAGE\tfakepkg\t1.0.0\t\t4.5.1\t1\tenvironment\tgitlab\tgitlab.com\tgroup\tfakepkg\tmain\tdeadbeef\n',
        stderr: ''
      })
    )
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      platform: 'win32',
      execFile: execute
    })

    const rTarget = {
      language: 'r' as const,
      environmentName: 'default-r',
      runtimeSource: 'managed' as const,
      command: `${prefix}\\Lib\\R\\bin\\Rscript.exe`,
      args: [],
      condaPrefix: prefix
    }
    await expect(tracker.prepareRun(rTarget)).resolves.toMatchObject({ inventoryRefreshed: true })
    await expect(tracker.inspectPackages(rTarget, ['ggplot2'])).resolves.toMatchObject({
      packages: [
        {
          name: 'ggplot2',
          version: '4.0.0.9000',
          source: {
            type: 'github',
            repository: 'tidyverse/ggplot2',
            ref: 'main',
            commit: 'a7b92f1',
            subdirectory: 'packages/ggplot2'
          }
        }
      ]
    })
    await expect(tracker.inspectPackages(rTarget, ['fakepkg'])).resolves.toMatchObject({
      packages: [{ name: 'fakepkg', version: '1.0.0', status: 'installed' }]
    })
    const fakePackage = (await tracker.inspectPackages(rTarget, ['fakepkg'])).packages[0]
    expect(fakePackage).not.toHaveProperty('source')

    expect(execute).toHaveBeenCalledTimes(6)
    expect(execute.mock.calls.map(([, , options]) => options.maxBuffer)).toEqual([
      8 * 1024 * 1024,
      16 * 1024 * 1024,
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      8 * 1024 * 1024
    ])
    for (const [command, , options] of execute.mock.calls) {
      expect(command).toBe(`${prefix}\\Lib\\R\\bin\\Rscript.exe`)
      expect(options.env.PATH).toContain(`${prefix}\\Library\\bin`)
    }
  })

  it('logs bounded child-process diagnostics when an inventory probe fails', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-probe-log-'))
    const warn = vi.fn()
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      logger: { warn, error: vi.fn() },
      inspectInstalled: vi.fn().mockRejectedValue(
        Object.assign(new Error('Rscript failed'), {
          code: 3221225781,
          stderr: 'token=super-secret libgcc_s_seh-1.dll missing',
          stdout: 'probe output'
        })
      ),
      captureFingerprint: vi.fn().mockResolvedValue('stable-r')
    })

    await expect(
      tracker.prepareRun({
        language: 'r',
        environmentName: 'default-r',
        runtimeSource: 'managed',
        command: 'C:\\runtime\\envs\\.r\\Lib\\R\\bin\\Rscript.exe',
        args: [],
        condaPrefix: 'C:\\runtime\\envs\\.r'
      })
    ).resolves.toMatchObject({ inventoryRefreshed: false })

    expect(warn).toHaveBeenCalledWith(
      'environment inventory probe failed',
      expect.objectContaining({
        language: 'r',
        environmentName: 'default-r',
        code: 3221225781,
        stderr: expect.objectContaining({ text: expect.stringContaining('token=[redacted]') })
      })
    )
  })

  it('inspects requested packages from the current installed inventory without importing them', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-inspect-'))
    const inspectInstalled = vi.fn().mockResolvedValue({
      runtimeVersion: '3.13.2',
      packages: [
        {
          name: 'NumPy',
          version: '2.2.0',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: ['python-importlib-metadata']
        }
      ]
    })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    const first = await tracker.inspectPackages(target, ['numpy', 'pandas'])
    const second = await tracker.inspectPackages(target, ['numpy'])

    expect(first).toMatchObject({
      inventory: { source: 'full-scan', validation: 'full-scan' },
      packages: [
        {
          requested: 'numpy',
          name: 'NumPy',
          status: 'installed',
          version: '2.2.0',
          versionStatus: 'known'
        },
        { requested: 'pandas', name: 'pandas', status: 'missing' }
      ]
    })
    expect(second.inventory).toMatchObject({ source: 'cache-reused', validation: 'best-effort' })
    expect(inspectInstalled).toHaveBeenCalledOnce()
  })

  it('inspects an R GitHub spec by repository and ref', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-inspect-github-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'ggplot2',
            version: '4.0.0.9000',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            source: {
              type: 'github',
              repository: 'tidyverse/ggplot2',
              ref: 'main',
              commit: 'abc123'
            }
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-r')
    })
    const rTarget = { ...target, language: 'r' as const, command: '/opt/r/bin/Rscript' }

    const result = await tracker.inspectPackages(rTarget, ['tidyverse/ggplot2@main'])

    expect(result.packages).toEqual([
      expect.objectContaining({
        requested: 'tidyverse/ggplot2@main',
        name: 'ggplot2',
        status: 'installed',
        version: '4.0.0.9000',
        source: expect.objectContaining({ repository: 'tidyverse/ggplot2', ref: 'main' })
      })
    ])
  })

  it('reports unknown instead of missing when installed inventory cannot be read', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-inspect-unavailable-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockRejectedValue(new Error('interpreter unavailable')),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    const result = await tracker.inspectPackages(target, ['numpy'])

    expect(result).toMatchObject({
      inventory: { source: 'unavailable', validation: 'unavailable' },
      packages: [{ requested: 'numpy', name: 'numpy', status: 'unknown' }]
    })
    expect(result.warnings?.join('\n')).toContain('interpreter unavailable')
  })

  it('captures a baseline before the first package mutation so installs have a verified change', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-first-mutation-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
      .mockResolvedValueOnce({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-first-install',
      operation: 'install',
      packages: ['numpy']
    })
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-first-install',
      operation: 'install',
      packages: ['numpy'],
      result: 'success'
    })

    expect(inspectInstalled).toHaveBeenCalledTimes(2)
    expect(verification.packageChanges).toEqual([
      expect.objectContaining({
        name: 'numpy',
        relationship: 'requested',
        change: 'installed',
        afterVersion: '2.2.0'
      })
    ])
  })

  it('rejects an installed Python package whose inventory version differs from the exact request', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-version-mismatch-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
      .mockResolvedValueOnce({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.1.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-version-mismatch',
      operation: 'install',
      packages: ['numpy==2.0.0']
    })
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-version-mismatch',
      operation: 'install',
      packages: ['numpy==2.0.0'],
      result: 'success'
    })

    expect(verification).toMatchObject({
      result: 'failure',
      unsatisfiedPackages: ['numpy==2.0.0']
    })
  })

  it('accepts equivalent normalized Python versions for an exact request', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-version-normalized-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
      .mockResolvedValueOnce({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-version-normalized',
      operation: 'install',
      packages: ['numpy==2.0.0']
    })
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-version-normalized',
      operation: 'install',
      packages: ['numpy==2.0.0'],
      result: 'success'
    })

    expect(verification.result).toBe('success')
  })

  it('matches a GitHub request to the installed R package source and retains related changes', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-github-mutation-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({ runtimeVersion: '4.5.1', packages: [] })
      .mockResolvedValueOnce({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'ggplot2',
            version: '4.0.0.9000',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            source: {
              type: 'github',
              repository: 'tidyverse/ggplot2',
              ref: 'main',
              commit: 'a7b92f1'
            }
          },
          {
            name: 'S7',
            version: '0.2.0',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          }
        ]
      })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-r')
    })
    const rTarget = {
      ...target,
      language: 'r' as const,
      command: '/opt/r/bin/Rscript'
    }

    await tracker.markPackageMutationDirty(rTarget, {
      operationId: 'operation-github-install',
      operation: 'install',
      packages: ['tidyverse/ggplot2@main']
    })
    const verification = await tracker.refreshAfterPackageMutation(rTarget, {
      operationId: 'operation-github-install',
      operation: 'install',
      packages: ['tidyverse/ggplot2@main'],
      result: 'success'
    })

    expect(verification).toMatchObject({
      result: 'success',
      packageChanges: [
        {
          name: 'ggplot2',
          relationship: 'requested',
          change: 'installed',
          afterVersion: '4.0.0.9000',
          source: {
            type: 'github',
            repository: 'tidyverse/ggplot2',
            ref: 'main',
            commit: 'a7b92f1'
          }
        },
        {
          name: 'S7',
          relationship: 'unattributed',
          change: 'installed',
          afterVersion: '0.2.0'
        }
      ]
    })
  })

  it.each(['ref', 'subdirectory'] as const)(
    'rejects a GitHub package when the installed source has a different requested %s',
    async (mismatch) => {
      dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-github-ref-mismatch-'))
      const installedPackage = {
        name: 'ggplot2',
        version: '4.0.0.9000',
        versionStatus: 'known' as const,
        ecosystem: 'r' as const,
        evidenceSources: ['r-installed-packages' as const],
        source: {
          type: 'github' as const,
          repository: 'tidyverse/ggplot2',
          ref: mismatch === 'ref' ? 'release' : 'main',
          ...(mismatch === 'subdirectory' ? { subdirectory: 'packages/ggplot2' } : {})
        }
      }
      const tracker = new EnvironmentStateTracker({
        dataRoot,
        inspectInstalled: vi
          .fn()
          .mockResolvedValueOnce({ runtimeVersion: '4.5.1', packages: [] })
          .mockResolvedValueOnce({ runtimeVersion: '4.5.1', packages: [installedPackage] }),
        captureFingerprint: vi.fn().mockResolvedValue('stable-r')
      })
      const rTarget = { ...target, language: 'r' as const, command: '/opt/r/bin/Rscript' }

      await tracker.markPackageMutationDirty(rTarget, {
        operationId: 'operation-github-ref-mismatch',
        operation: 'install',
        packages: ['tidyverse/ggplot2@main']
      })
      const verification = await tracker.refreshAfterPackageMutation(rTarget, {
        operationId: 'operation-github-ref-mismatch',
        operation: 'install',
        packages: ['tidyverse/ggplot2@main'],
        result: 'success'
      })

      expect(verification).toMatchObject({
        result: 'failure',
        unsatisfiedPackages: ['tidyverse/ggplot2@main']
      })
      expect(
        (await tracker.inspectPackages(rTarget, ['tidyverse/ggplot2@main'])).packages[0]?.status
      ).toBe('missing')
    }
  )

  it('does not classify a Python path package as a GitHub source request', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-python-path-mutation-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi
        .fn()
        .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
        .mockResolvedValueOnce({
          runtimeVersion: '3.13.2',
          packages: [
            {
              name: 'localpkg',
              version: '1.0.0',
              versionStatus: 'known',
              ecosystem: 'python',
              evidenceSources: ['python-importlib-metadata']
            }
          ]
        }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-python-path-install',
      operation: 'install',
      packages: ['./localpkg']
    })
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-python-path-install',
      operation: 'install',
      packages: ['./localpkg'],
      result: 'success'
    })

    expect(verification.result).toBe('success')
  })

  it.each(['ref-and-commit', 'subdirectory'] as const)(
    'reports a GitHub %s mutation when the package version is unchanged',
    async (scenario) => {
      dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-github-source-change-'))
      const githubPackage = (
        ref: string,
        commit: string,
        subdirectory?: string
      ): NotebookEnvironmentPackage => ({
        name: 'ggplot2',
        version: '4.0.0.9000',
        versionStatus: 'known' as const,
        ecosystem: 'r' as const,
        evidenceSources: ['r-installed-packages' as const],
        source: {
          type: 'github' as const,
          repository: 'tidyverse/ggplot2',
          ref,
          commit,
          subdirectory
        }
      })
      const tracker = new EnvironmentStateTracker({
        dataRoot,
        inspectInstalled: vi
          .fn()
          .mockResolvedValueOnce({
            runtimeVersion: '4.5.1',
            packages: [githubPackage(scenario === 'subdirectory' ? 'release' : 'main', 'abc123')]
          })
          .mockResolvedValueOnce({
            runtimeVersion: '4.5.1',
            packages: [
              githubPackage(
                'release',
                scenario === 'subdirectory' ? 'abc123' : 'def456',
                scenario === 'subdirectory' ? 'packages/ggplot2' : undefined
              )
            ]
          }),
        captureFingerprint: vi.fn().mockResolvedValue('stable-r')
      })
      const rTarget = { ...target, language: 'r' as const, command: '/opt/r/bin/Rscript' }

      await tracker.markPackageMutationDirty(rTarget, {
        operationId: 'operation-github-source-change',
        operation: 'install',
        packages: ['tidyverse/ggplot2@release']
      })
      const verification = await tracker.refreshAfterPackageMutation(rTarget, {
        operationId: 'operation-github-source-change',
        operation: 'install',
        packages: ['tidyverse/ggplot2@release'],
        result: 'success'
      })

      expect(verification.packageChanges).toEqual([
        expect.objectContaining({
          name: 'ggplot2',
          relationship: 'requested',
          change: 'updated',
          beforeVersion: '4.0.0.9000',
          afterVersion: '4.0.0.9000',
          source: expect.objectContaining({
            ref: 'release',
            commit: scenario === 'subdirectory' ? 'abc123' : 'def456',
            ...(scenario === 'subdirectory' ? { subdirectory: 'packages/ggplot2' } : {})
          })
        })
      ])
    }
  )

  it('captures a baseline before the first package mutation so uninstalls have a verified change', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-first-uninstall-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      })
      .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-first-uninstall',
      operation: 'uninstall',
      packages: ['numpy']
    })
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-first-uninstall',
      operation: 'uninstall',
      packages: ['numpy'],
      result: 'success'
    })

    expect(inspectInstalled).toHaveBeenCalledTimes(2)
    expect(verification.packageChanges).toEqual([
      expect.objectContaining({
        name: 'numpy',
        relationship: 'requested',
        change: 'removed',
        beforeVersion: '2.2.0'
      })
    ])
  })

  it('keeps the first package mutation repairable when the baseline inventory is unavailable', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-unavailable-baseline-'))
    const inspectInstalled = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime metadata is temporarily unavailable'))
      .mockResolvedValueOnce({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    await expect(
      tracker.markPackageMutationDirty(target, {
        operationId: 'operation-repair-install',
        operation: 'install',
        packages: ['numpy']
      })
    ).resolves.toBeUndefined()
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-repair-install',
      operation: 'install',
      packages: ['numpy'],
      result: 'success'
    })

    expect(inspectInstalled).toHaveBeenCalledTimes(2)
    expect(verification).toMatchObject({
      result: 'success',
      packageChanges: [
        expect.objectContaining({
          name: 'numpy',
          relationship: 'requested',
          change: 'observed',
          afterVersion: '2.2.0'
        })
      ]
    })
  })

  it('reuses immutable installed inventory while capturing fresh live-Kernel state per run', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-state-'))
    const inspectInstalled = vi.fn().mockResolvedValue({
      runtimeVersion: '3.13.2',
      platform: 'linux',
      architecture: 'aarch64',
      packages: [
        {
          name: 'numpy',
          version: '2.2.0',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: ['python-importlib-metadata']
        }
      ]
    })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    const first = await tracker.captureCompletedRun(target, {
      runtimeVersion: '3.13.2',
      packages: [
        {
          name: 'numpy',
          version: '2.2.0',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: ['python-kernel-modules'],
          loadedState: 'loaded'
        }
      ]
    })
    const second = await tracker.captureCompletedRun(target, {
      runtimeVersion: '3.13.2',
      packages: [
        {
          name: 'pandas',
          version: '2.2.3',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: ['python-kernel-modules'],
          loadedState: 'loaded'
        }
      ]
    })

    expect(inspectInstalled).toHaveBeenCalledOnce()
    expect(first.manifest.installedInventory.source).toBe('full-scan')
    expect(second.manifest.installedInventory.source).toBe('cache-reused')
    expect(second.manifest).toMatchObject({
      complete: true,
      captureStatus: 'complete',
      installedInventory: { validation: 'best-effort' }
    })
    expect(second.manifest.warnings).toContain('inventory-cache-best-effort')
    expect(first.manifest).toMatchObject({ platform: 'linux', architecture: 'aarch64' })
    expect(second.manifest.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'numpy', loadedState: 'installed-only' }),
        expect.objectContaining({ name: 'pandas', loadedState: 'loaded' })
      ])
    )
    expect(first.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(second.checksum).toMatch(/^[a-f0-9]{64}$/)
    await expect(readFile(first.storagePath, 'utf8')).resolves.toBe(
      `${JSON.stringify(first.manifest, null, 2)}\n`
    )
  })

  it('publishes one content-addressed micromamba lock per unchanged environment revision', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-lock-'))
    const condaPrefix = join(dataRoot, 'runtime', 'envs', 'default-python')
    await mkdir(join(condaPrefix, 'conda-meta'), { recursive: true })
    await writeFile(join(condaPrefix, 'conda-meta', 'history'), 'created\n')
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify([
        {
          name: 'numpy',
          version: '2.2.0',
          url: 'https://conda.example/linux-64/numpy-2.2.0-py313_0.conda',
          md5: '0123456789abcdef0123456789abcdef'
        }
      ]),
      stderr: ''
    }))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      resolveMicromamba: vi.fn().mockResolvedValue('/runtime/micromamba'),
      execFile: execute,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '3.13.2',
        platform: 'linux',
        architecture: 'x64',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python'),
      now: () => new Date('2026-09-02T00:00:00.000Z')
    })

    const target = {
      language: 'python' as const,
      environmentName: 'default-python',
      runtimeSource: 'managed' as const,
      command: join(condaPrefix, 'bin', 'python'),
      condaPrefix
    }
    const live = {
      runtimeVersion: '3.13.2',
      packages: [
        {
          name: 'numpy',
          version: '2.2.0',
          versionStatus: 'known' as const,
          ecosystem: 'python' as const,
          evidenceSources: ['python-kernel-modules' as const]
        }
      ]
    }
    const capture = await tracker.captureCompletedRun(target, live)
    const repeated = await tracker.captureCompletedRun(target, live)

    expect(capture.environmentLock).toMatchObject({
      state: 'available',
      format: 'environment-lock-bundle',
      lockChecksum: expect.stringMatching(/^[a-f0-9]{64}$/u)
    })
    if (capture.environmentLock.state === 'unavailable') throw new Error('Expected a lock.')
    expect(repeated.environmentLock).toMatchObject({
      state: 'available',
      lockChecksum: capture.environmentLock.lockChecksum
    })
    if (repeated.environmentLock.state === 'unavailable') throw new Error('Expected a lock.')
    const serialized = await readFile(
      join(
        dataRoot,
        'runtime',
        'provenance',
        'environment-locks',
        `${capture.environmentLock.lockChecksum}.json`
      ),
      'utf8'
    )
    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: 1,
      format: 'environment-lock-bundle',
      kernelKind: 'python',
      environmentName: 'default-python'
    })
    expect(JSON.parse(serialized)).not.toHaveProperty('capturedAt')
    expect(JSON.parse(serialized)).not.toHaveProperty('environmentManifestChecksum')

    const outputChecksum = 'a'.repeat(64)
    const graph: ArtifactProvenanceGraph = {
      schemaVersion: 1,
      targetEntityId: 'artifact-version:version-1',
      completeness: 'complete',
      reasonCodes: [],
      activities: [
        {
          activityId: 'run-1',
          kind: 'notebook-run',
          sequence: 0,
          runIndex: 0,
          inclusion: 'target-closure',
          evidenceState: 'available'
        },
        {
          activityId: 'artifact-publication:version-1',
          kind: 'artifact-publication',
          sequence: 1,
          parentActivityId: 'run-1',
          inclusion: 'target-closure',
          evidenceState: 'available'
        }
      ],
      entities: [
        {
          entityId: 'file-generation:output-1',
          kind: 'file-generation',
          generationId: 'output-1',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          checksum: outputChecksum,
          sizeBytes: 10,
          contentStorageKey: `execution-file-evidence/blobs/sha256-${outputChecksum}`
        },
        {
          entityId: 'artifact-version:version-1',
          kind: 'artifact-version',
          versionId: 'version-1',
          filename: 'result.csv',
          checksum: outputChecksum,
          sizeBytes: 10
        }
      ],
      edges: [
        {
          kind: 'generated',
          activityId: 'run-1',
          entityId: 'file-generation:output-1',
          authority: 'advisory',
          evidenceSource: 'runtime-observation'
        },
        {
          kind: 'used',
          activityId: 'artifact-publication:version-1',
          entityId: 'file-generation:output-1',
          authority: 'authoritative',
          evidenceSource: 'artifact-publication'
        },
        {
          kind: 'generated',
          activityId: 'artifact-publication:version-1',
          entityId: 'artifact-version:version-1',
          authority: 'authoritative',
          evidenceSource: 'artifact-publication'
        }
      ]
    }
    const run: ProvenanceNotebookRun = {
      runId: 'run-1',
      runIndex: 0,
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1',
      kernelKind: 'python',
      environmentName: 'default-python',
      environmentLock: repeated.environmentLock,
      script: 'write_result()',
      status: 'completed',
      startedAt: '2026-09-02T00:00:00.000Z',
      completedAt: '2026-09-02T00:00:01.000Z',
      outputs: [],
      inputFileVersionKeys: []
    }
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph,
      inputFiles: [],
      runs: [run]
    })
    await expect(
      prepareArtifactReproducibilityExecutionPlan(recipe, 'original-inputs', dataRoot)
    ).resolves.toMatchObject({
      steps: [{ activityId: 'run-1' }],
      environmentRequirements: [{ lockChecksum: repeated.environmentLock.lockChecksum }]
    })

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('refreshes the inventory once after one logical package mutation', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-mutation-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'cli',
            version: '3.6.3',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          },
          {
            name: 'rlang',
            version: '1.1.4',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          }
        ]
      })
      .mockResolvedValueOnce({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'cli',
            version: '3.6.3',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          },
          {
            name: 'ggplot2',
            version: '3.5.2',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          },
          {
            name: 'rlang',
            version: '1.1.5',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          },
          {
            name: 'scales',
            version: '1.3.0',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          }
        ]
      })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-r')
    })
    const rTarget = {
      language: 'r' as const,
      environmentName: 'default-r',
      runtimeSource: 'managed' as const,
      command: '/runtime/default-r/bin/Rscript',
      args: []
    }
    await tracker.captureCompletedRun(rTarget)

    await tracker.markPackageMutationDirty(rTarget, {
      operationId: 'operation-1',
      operation: 'install',
      packages: ['ggplot2']
    })
    const verification = await tracker.refreshAfterPackageMutation(rTarget, {
      operationId: 'operation-1',
      operation: 'install',
      packages: ['ggplot2'],
      result: 'success',
      source: { type: 'bioconductor', version: '3.21' },
      fallbackUsed: true,
      attempts: [
        {
          groupOrdinal: 0,
          installer: 'conda',
          packages: ['r-ggplot2'],
          status: 'failed',
          mutationRisk: 'none',
          reason: 'package-not-found'
        },
        {
          groupOrdinal: 1,
          installer: 'r-install-packages',
          packages: ['ggplot2'],
          status: 'succeeded',
          mutationRisk: 'confirmed'
        }
      ]
    })
    const capture = await tracker.captureCompletedRun(rTarget)

    expect(inspectInstalled).toHaveBeenCalledTimes(2)
    // BiocManager's active release must not relabel a CRAN package.
    expect(
      verification.packageChanges?.find((change) => change.name === 'ggplot2')
    ).not.toHaveProperty('source')
    expect(
      capture.manifest.operationLog?.[0]?.packageChanges?.find(
        (change) => change.name === 'ggplot2'
      )
    ).not.toHaveProperty('source')
    expect(verification.packageChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'ggplot2',
          relationship: 'requested',
          change: 'installed',
          afterVersion: '3.5.2'
        }),
        expect.objectContaining({
          name: 'rlang',
          relationship: 'unattributed',
          change: 'updated',
          beforeVersion: '1.1.4',
          afterVersion: '1.1.5'
        })
      ])
    )
    expect(capture.manifest.packages).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'ggplot2', version: '3.5.2' })])
    )
    expect(capture.manifest.operationLog).toEqual([
      expect.objectContaining({
        operationId: 'operation-1',
        result: 'success',
        fallbackUsed: true,
        inventoryRefresh: 'published',
        inventoryRefreshAttempts: [expect.objectContaining({ result: 'published' })],
        packageChanges: [
          expect.objectContaining({
            name: 'ggplot2',
            relationship: 'requested',
            change: 'installed',
            afterVersion: '3.5.2'
          }),
          expect.objectContaining({
            name: 'rlang',
            relationship: 'unattributed',
            change: 'updated',
            beforeVersion: '1.1.4',
            afterVersion: '1.1.5'
          }),
          expect.objectContaining({
            name: 'scales',
            relationship: 'unattributed',
            change: 'installed',
            afterVersion: '1.3.0'
          })
        ],
        attempts: [
          expect.objectContaining({ installer: 'conda', status: 'failed' }),
          expect.objectContaining({ installer: 'r-install-packages', status: 'succeeded' })
        ]
      })
    ])
    const manifestDirectory = join(dataRoot, 'runtime', 'provenance', 'environment-manifests')
    const manifests = await Promise.all(
      (await readdir(manifestDirectory)).map(
        async (name) =>
          JSON.parse(await readFile(join(manifestDirectory, name), 'utf8')) as {
            captureKind?: string
            operationLog?: Array<{ operationId?: string }>
          }
      )
    )
    expect(manifests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          captureKind: 'operation',
          operationLog: [expect.objectContaining({ operationId: 'operation-1' })]
        })
      ])
    )
  })

  it('retains only the newest completed operations within the entry budget', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-log-count-'))
    let timestamp = Date.parse('2026-07-27T10:00:00.000Z')
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python'),
      now: () => new Date((timestamp += 1_000)),
      operationLogLimits: { maxEntries: 3, maxBytes: 1_000_000 }
    })

    for (let index = 1; index <= 5; index += 1) {
      const operationId = `operation-${index}`
      await tracker.markPackageMutationDirty(target, {
        operationId,
        operation: 'install',
        packages: ['numpy']
      })
      await tracker.refreshAfterPackageMutation(target, {
        operationId,
        operation: 'install',
        packages: ['numpy'],
        result: 'success'
      })
    }

    const capture = await tracker.captureCompletedRun(target)
    expect(capture.manifest.operationLog?.map((operation) => operation.operationId)).toEqual([
      'operation-3',
      'operation-4',
      'operation-5'
    ])
    expect(capture.manifest.operationLogTruncation).toEqual({
      omittedCount: 2,
      earliestRetainedAt: capture.manifest.operationLog?.[0].timestamp
    })
    await expect(readBinding(dataRoot)).resolves.toMatchObject({
      operationLog: [
        { operationId: 'operation-3' },
        { operationId: 'operation-4' },
        { operationId: 'operation-5' }
      ],
      operationLogTruncation: { omittedCount: 2 }
    })
  })

  it('bounds byte-heavy completed operation history by serialized size', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-log-bytes-'))
    const maxBytes = 2_500
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({ runtimeVersion: '3.13.2', packages: [] }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python'),
      operationLogLimits: { maxEntries: 20, maxBytes }
    })

    for (let index = 1; index <= 4; index += 1) {
      const operationId = `large-operation-${index}`
      const packageSpec = `missing-${index}-${'x'.repeat(300)}`
      await tracker.markPackageMutationDirty(target, {
        operationId,
        operation: 'install',
        packages: [packageSpec]
      })
      await tracker.refreshAfterPackageMutation(target, {
        operationId,
        operation: 'install',
        packages: [packageSpec],
        result: 'failure'
      })
    }

    const binding = await readBinding(dataRoot)
    const persistedBytes = Buffer.byteLength(await readFile(await bindingPath(dataRoot), 'utf8'))
    expect(persistedBytes).toBeLessThanOrEqual(maxBytes)
    expect(binding.operationLog.at(-1)?.operationId).toBe('large-operation-4')
    expect(binding.operationLogTruncation?.omittedCount).toBeGreaterThan(0)
  })

  it('retains the recovery-critical operation even when it exceeds both budgets', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-log-recovery-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockRejectedValue(new Error('inventory unavailable')),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python'),
      operationLogLimits: { maxEntries: 0, maxBytes: 0 }
    })

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-pending-recovery',
      operation: 'install',
      packages: ['numpy']
    })
    await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-pending-recovery',
      operation: 'install',
      packages: ['numpy'],
      result: 'success'
    })

    await expect(readBinding(dataRoot)).resolves.toMatchObject({
      dirtyOperationId: 'operation-pending-recovery',
      operationLog: [{ operationId: 'operation-pending-recovery' }]
    })
  })

  it.each([
    { requested: ['dplyr'], missing: 'dplyr' },
    { requested: ['ggplot2', 'DESeq2'], missing: 'DESeq2' }
  ])(
    'rejects installer success when $missing is absent from the R inventory',
    async ({ requested, missing }) => {
      dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-unverified-mutation-'))
      const inspectInstalled = vi.fn().mockResolvedValue({
        runtimeVersion: '4.4.3',
        packages: [
          {
            name: 'ggplot2',
            version: '4.0.3',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          }
        ]
      })
      const tracker = new EnvironmentStateTracker({
        dataRoot,
        inspectInstalled,
        captureFingerprint: vi.fn().mockResolvedValue('stable-r')
      })
      const rTarget = {
        language: 'r' as const,
        environmentName: 'default-r',
        runtimeSource: 'managed' as const,
        command: '/runtime/default-r/bin/Rscript',
        args: []
      }

      await tracker.markPackageMutationDirty(rTarget, {
        operationId: 'operation-missing-r-package',
        operation: 'install',
        packages: requested
      })
      const verification = await tracker.refreshAfterPackageMutation(rTarget, {
        operationId: 'operation-missing-r-package',
        operation: 'install',
        packages: requested,
        result: 'success',
        source: { type: 'bioconductor', version: '3.20' }
      })
      const capture = await tracker.captureCompletedRun(rTarget)

      expect(verification).toMatchObject({ result: 'failure', unsatisfiedPackages: [missing] })
      expect(capture.manifest.operationLog).toEqual([
        expect.objectContaining({
          operationId: 'operation-missing-r-package',
          result: 'failure',
          packages: requested
        })
      ])
      expect(capture.manifest.packages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: missing })])
      )
    }
  )

  it('fails verification when the post-install inventory cannot be refreshed', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-refresh-failure-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi
        .fn()
        .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
        .mockRejectedValueOnce(new Error('inventory unavailable')),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })
    const pythonTarget = {
      language: 'python' as const,
      environmentName: 'default-python',
      runtimeSource: 'managed' as const,
      command: '/runtime/default-python/bin/python',
      args: []
    }

    await tracker.markPackageMutationDirty(pythonTarget, {
      operationId: 'operation-inventory-failed',
      operation: 'install',
      packages: ['numpy']
    })

    await expect(
      tracker.refreshAfterPackageMutation(pythonTarget, {
        operationId: 'operation-inventory-failed',
        operation: 'install',
        packages: ['numpy'],
        result: 'success'
      })
    ).resolves.toEqual({ result: 'failure', reason: 'inventory-refresh-failed' })
  })

  it('retains the observed Bioconductor release when a failed refresh is recovered', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-source-recovery-'))
    const rTarget = {
      language: 'r' as const,
      environmentName: 'default-r',
      runtimeSource: 'managed' as const,
      command: '/runtime/default-r/bin/Rscript',
      args: []
    }
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({ runtimeVersion: '4.5.1', packages: [] })
      .mockImplementationOnce(async () => {
        const operations = await readdir(join(dirname(await bindingPath(dataRoot!)), 'operations'))
        const persisted = JSON.parse(
          await readFile(
            join(dirname(await bindingPath(dataRoot!)), 'operations', operations[0]),
            'utf8'
          )
        )
        expect(persisted).toMatchObject({
          lifecycle: 'terminal-refresh-pending',
          terminalResult: 'success',
          source: { type: 'bioconductor', version: '3.21' }
        })
        throw new Error('inventory unavailable')
      })
    const initial = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('before-install')
    })
    await initial.markPackageMutationDirty(rTarget, {
      operationId: 'operation-bioc-recovery',
      operation: 'install',
      packages: ['DESeq2']
    })
    await expect(
      initial.refreshAfterPackageMutation(rTarget, {
        operationId: 'operation-bioc-recovery',
        operation: 'install',
        packages: ['DESeq2'],
        result: 'success',
        source: { type: 'bioconductor', version: '3.21' }
      })
    ).resolves.toEqual({ result: 'failure', reason: 'inventory-refresh-failed' })

    const recovered = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'DESeq2',
            version: '1.48.1',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            source: { type: 'bioconductor', version: '3.20' }
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('after-install')
    })
    const start = await recovered.prepareRun(rTarget)
    const capture = await recovered.captureCompletedRun(
      rTarget,
      { runtimeVersion: '4.5.1', packages: [] },
      start
    )

    expect(capture.manifest.operationLog).toEqual([
      expect.objectContaining({
        operationId: 'operation-bioc-recovery',
        packageChanges: [
          expect.objectContaining({
            name: 'DESeq2',
            relationship: 'requested',
            source: { type: 'bioconductor', version: '3.20' }
          })
        ]
      })
    ])
  })

  it('forces a terminal rescan and marks evidence partial when package state changes during a run', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-fingerprint-'))
    const inspectInstalled = vi.fn().mockResolvedValue({
      runtimeVersion: '3.13.2',
      packages: []
    })
    const captureFingerprint = vi
      .fn()
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('after')
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint
    })

    const start = await tracker.prepareRun(target)
    const capture = await tracker.captureCompletedRun(
      target,
      { runtimeVersion: '3.13.2', packages: [] },
      start
    )

    expect(inspectInstalled).toHaveBeenCalledTimes(2)
    expect(capture.manifest).toMatchObject({
      captureStatus: 'partial',
      complete: false,
      installedInventory: { source: 'full-scan' }
    })
    expect(capture.manifest.warnings).toContain('environment-changed-during-run')
  })

  it('recovers a durable pending package operation before allowing the next run', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-recovery-'))
    const initial = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({ runtimeVersion: '3.13.2', packages: [] }),
      captureFingerprint: vi.fn().mockResolvedValue('before-install')
    })
    await initial.captureCompletedRun(target)
    await initial.markPackageMutationDirty(target, {
      operationId: 'operation-crashed',
      operation: 'install',
      packages: ['pandas']
    })

    const blocked = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockRejectedValue(new Error('environment still locked')),
      captureFingerprint: vi.fn().mockResolvedValue('unknown')
    })
    await expect(blocked.prepareRun(target)).rejects.toThrow(/recovery failed before Notebook/)

    const recovered = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'pandas',
            version: '2.3.3',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('after-install')
    })
    const recoveredStart = await recovered.prepareRun(target)
    expect(recoveredStart).toMatchObject({
      fingerprint: 'after-install',
      inventoryRefreshed: true
    })
    const recoveredCapture = await recovered.captureCompletedRun(
      target,
      { runtimeVersion: '3.13.2', packages: [] },
      recoveredStart
    )
    expect(recoveredCapture.manifest.operationLog).toEqual([
      expect.objectContaining({
        operationId: 'operation-crashed',
        packageChanges: [
          expect.objectContaining({
            name: 'pandas',
            relationship: 'requested',
            change: 'installed',
            afterVersion: '2.3.3'
          })
        ]
      })
    ])
  })

  it('records an explicit partial manifest when an external Runtime cannot be inspected', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-partial-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockRejectedValue(new Error('interpreter unavailable')),
      captureFingerprint: vi.fn().mockResolvedValue(undefined)
    })

    const capture = await tracker.captureCompletedRun(target)

    expect(capture.manifest).toMatchObject({
      runtimeSource: 'external',
      complete: false,
      captureStatus: 'partial',
      packages: []
    })
    expect(capture.manifest.warnings?.join(' ')).toMatch(/interpreter unavailable/)
  })

  it('preserves same-named R packages installed in different library ranks', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-r-libraries-'))
    const rTarget = {
      language: 'r' as const,
      environmentName: 'default-r',
      runtimeSource: 'managed' as const,
      command: '/runtime/default-r/bin/Rscript',
      args: []
    }
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'rlang',
            version: '1.1.6',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            libraryRank: 1,
            libraryScope: 'environment'
          },
          {
            name: 'rlang',
            version: '1.1.5',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            libraryRank: 2,
            libraryScope: 'user'
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-r-libraries')
    })

    const capture = await tracker.captureCompletedRun(rTarget, {
      runtimeVersion: '4.5.1',
      packages: [
        {
          name: 'rlang',
          version: '1.1.6',
          versionStatus: 'known',
          ecosystem: 'r',
          evidenceSources: ['r-session-info'],
          loadedState: 'loaded',
          libraryRank: 1
        }
      ]
    })

    expect(capture.manifest.packages).toEqual([
      expect.objectContaining({
        name: 'rlang',
        version: '1.1.6',
        libraryRank: 1,
        libraryScope: 'environment',
        loadedState: 'loaded'
      }),
      expect.objectContaining({
        name: 'rlang',
        version: '1.1.5',
        libraryRank: 2,
        libraryScope: 'user',
        loadedState: 'installed-only'
      })
    ])
  })

  it('keeps pre-activation R recovery state visible after adding a Conda prefix', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-r-upgrade-recovery-'))
    const legacyTarget = {
      language: 'r' as const,
      environmentName: 'default-r',
      runtimeSource: 'managed' as const,
      command: 'C:\\runtime\\envs\\.r\\Lib\\R\\bin\\Rscript.exe',
      args: []
    }
    const initial = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({ runtimeVersion: '4.5.1', packages: [] }),
      captureFingerprint: vi.fn().mockResolvedValue('before-install')
    })
    await initial.markPackageMutationDirty(legacyTarget, {
      operationId: 'operation-from-older-nightly',
      operation: 'install',
      packages: ['ggplot2']
    })

    const upgraded = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockRejectedValue(new Error('environment still locked')),
      captureFingerprint: vi.fn().mockResolvedValue('unknown')
    })

    await expect(
      upgraded.prepareRun({
        ...legacyTarget,
        condaPrefix: 'C:\\runtime\\envs\\.r'
      })
    ).rejects.toThrow(/recovery failed before Notebook/)
  })
})
