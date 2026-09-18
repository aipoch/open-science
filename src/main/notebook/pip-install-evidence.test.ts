import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { installPackages } from './package-manager'
import { EnvironmentLockCaptureOwner } from './environment-lock'
import { envPrefix, runtimeRoot } from './runtime-paths'

describe('managed pip installation evidence', () => {
  it.each([
    'wheel',
    'fallback',
    'failed',
    'sdist',
    'private',
    'modified',
    'no-report',
    'corrupt-report',
    'evidence-symlink',
    'windows-layout'
  ] as const)('captures only restorable, unchanged %s installation evidence', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'pip-install-evidence-'))
    const prefix = envPrefix(runtimeRoot(root), 'default-python')
    const distribution =
      scenario === 'windows-layout'
        ? join(prefix, 'Lib', 'site-packages', 'pandas-3.0.5.dist-info')
        : join(prefix, 'lib', 'python3.12', 'site-packages', 'pandas-3.0.5.dist-info')
    const digest = 'a'.repeat(64)
    let reportPath: string | undefined
    try {
      await mkdir(distribution, { recursive: true })
      await writeFile(join(distribution, 'METADATA'), 'Name: pandas\nVersion: 3.0.5\n')
      await writeFile(join(distribution, 'RECORD'), 'pandas/__init__.py,sha256=original,100\n')
      await mkdir(join(prefix, 'conda-meta'))
      await writeFile(join(prefix, 'conda-meta', 'history'), 'baseline')
      if (scenario === 'evidence-symlink') {
        await mkdir(join(root, 'outside-prefix'))
        await symlink(join(root, 'outside-prefix'), join(prefix, '.open-science-pip'), 'junction')
      }
      const installed = await installPackages(
        { language: 'python', packages: ['pandas'], usePip: scenario !== 'fallback' },
        {
          storageRoot: root,
          micromamba: 'micromamba',
          spawn: async (command, args, env) => {
            if (command === 'micromamba')
              return args.includes('clean')
                ? { code: 0, stdout: '', stderr: '' }
                : {
                    code: 1,
                    stdout: JSON.stringify({
                      success: false,
                      solver_problems: [
                        'pandas does not exist (perhaps a typo or a missing channel).'
                      ],
                      actions: { LINK: [], UNLINK: [], FETCH: [] }
                    }),
                    stderr: ''
                  }
            reportPath = env?.PIP_REPORT
            expect(reportPath).toBeDefined()
            if (scenario === 'no-report') return { code: 0, stdout: '', stderr: '' }
            if (scenario === 'corrupt-report') {
              await writeFile(reportPath!, '{invalid')
              return { code: 0, stdout: '', stderr: '' }
            }
            await writeFile(
              reportPath!,
              JSON.stringify({
                version: '1',
                install: [
                  {
                    metadata: { name: 'pandas', version: '3.0.5' },
                    download_info: {
                      url: `https://${scenario === 'private' ? 'private.example' : 'files.pythonhosted.org'}/packages/pandas-3.0.5.${scenario === 'sdist' ? 'tar.gz' : 'whl'}`,
                      archive_info: { hashes: { sha256: digest } }
                    }
                  }
                ]
              })
            )
            return { code: scenario === 'failed' ? 1 : 0, stdout: '', stderr: '' }
          }
        }
      )
      expect(installed.ok).toBe(scenario !== 'failed')
      expect((await readdir(distribution)).sort()).toEqual(['METADATA', 'RECORD'])
      if (scenario === 'evidence-symlink')
        expect(await readdir(join(root, 'outside-prefix'))).toEqual([])
      expect(reportPath).toBeDefined()
      await expect(readFile(reportPath!)).rejects.toThrow()
      const capture = new EnvironmentLockCaptureOwner()
      const take = (): ReturnType<EnvironmentLockCaptureOwner['capture']> =>
        capture.capture(
          {
            language: 'python',
            environmentName: 'default-python',
            runtimeSource: 'managed',
            condaPrefix: prefix
          },
          {
            schemaVersion: 1,
            captureKind: 'completed-run',
            capturedAt: '2026-09-05T00:00:00Z',
            installedInventory: {
              capturedAt: '2026-09-05T00:00:00Z',
              source: 'full-scan',
              validation: 'full-scan'
            },
            kernelKind: 'python',
            environmentName: 'default-python',
            runtimeSource: 'managed',
            inventorySources: ['interpreter-native'],
            packages: [
              {
                name: 'pandas',
                version: '3.0.5',
                versionStatus: 'known',
                ecosystem: 'python',
                evidenceSources: ['python-importlib-metadata']
              }
            ],
            complete: true,
            captureStatus: 'complete'
          },
          {
            micromamba: 'micromamba',
            environmentFingerprint: 'unchanged',
            execute: async () =>
              JSON.stringify([
                ...['python', 'pip'].map((name) => ({
                  name,
                  version: '1.0',
                  url: `https://conda.example/${name}.conda`,
                  md5: 'b'.repeat(32)
                })),
                { name: 'pandas', version: '3.0.5', channel: 'pypi', url: '', md5: '' }
              ])
          }
        )
      if (scenario === 'modified') {
        expect(await take()).toMatchObject({ state: 'captured', captureStatus: 'complete' })
        await writeFile(join(distribution, 'RECORD'), 'pandas/__init__.py,sha256=replaced,100\n')
      }
      const result = await take()
      const complete =
        scenario === 'wheel' || scenario === 'fallback' || scenario === 'windows-layout'
      expect(result).toMatchObject({
        state: 'captured',
        captureStatus: complete ? 'complete' : 'partial',
        lock: { untrackedPackages: ['python:pandas'] }
      })
      if (complete && result.state === 'captured') {
        expect(result.lock.components).toContainEqual(
          expect.objectContaining({
            ecosystem: 'python',
            format: 'pip-requirements',
            resolution: 'locked',
            files: [expect.objectContaining({ content: `pandas==3.0.5 --hash=sha256:${digest}\n` })]
          })
        )
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
