import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { compareReproducedContent } from './output-comparison'

import type {
  ArtifactReproducibilityCheckLogRecord,
  ArtifactReproducibilityReceipt,
  ExportArtifactEnvironmentLockRequest,
  ExportArtifactReproducibilityReceiptRequest
} from '../../shared/artifact-reproducibility'
import type { PersistedArtifactExecutionSnapshot } from '../../shared/artifact-provenance'
import type { NotebookEnvironmentLock } from '../../shared/notebook'
import {
  buildEnvironmentLockArchive,
  buildEnvironmentLockReadme,
  buildVerificationArchive,
  buildVerificationReport,
  createArtifactReproducibilityReceiptExporter,
  verificationArchiveName
} from './artifact-reproducibility-export'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'

const receipt = (): ArtifactReproducibilityReceipt => {
  const draft = {
    schemaVersion: 1 as const,
    receiptId: 'attempt-1',
    startedAt: '2026-09-02T00:00:00.000Z',
    completedAt: '2026-09-02T00:01:00.000Z',
    outcome: 'different' as const,
    artifactVersion: {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      targetChecksum: 'a'.repeat(64)
    },
    frontier: { frontierId: 'original-inputs', claimScope: 'end-to-end' as const },
    recipe: { recipeId: 'b'.repeat(64), graphChecksum: 'c'.repeat(64) },
    environmentLocks: [
      {
        requirementId: 'python:analysis',
        kernelKind: 'python' as const,
        environmentName: 'analysis',
        lockChecksum: 'd'.repeat(64)
      }
    ],
    completedStepIds: ['notebook:run-1'],
    comparisons: [
      {
        stepId: 'notebook:run-1',
        entityId: 'file-1',
        relativePath: 'results/report|draft.csv',
        status: 'different' as const,
        reason: 'checksum-mismatch' as const,
        expectedChecksum: 'e'.repeat(64),
        expectedSizeBytes: 10,
        actualChecksum: 'f'.repeat(64),
        actualSizeBytes: 11
      }
    ]
  }
  return {
    ...draft,
    receiptChecksum: sha256(canonicalJson(draft as unknown as CanonicalJson))
  }
}

const checkLog = (): ArtifactReproducibilityCheckLogRecord => {
  const payload = {
    schemaVersion: 1 as const,
    attemptId: 'attempt-1',
    entries: [
      {
        source: 'environment' as const,
        requirementId: 'python:analysis',
        environmentIndex: 0,
        environmentTotal: 1,
        kernelKind: 'python' as const,
        stream: 'stdout' as const,
        text: 'Linking numpy\n'
      }
    ],
    truncated: false
  }
  return {
    ...payload,
    logChecksum: sha256(canonicalJson(payload as unknown as CanonicalJson))
  }
}

const receiptWithCheckLog = (): {
  receipt: ArtifactReproducibilityReceipt
  log: ArtifactReproducibilityCheckLogRecord
} => {
  const log = checkLog()
  const current = receipt()
  const draft = {
    ...current,
    checkLog: {
      logChecksum: log.logChecksum,
      entryCount: log.entries.length,
      sizeBytes: Buffer.byteLength(canonicalJson(log as unknown as CanonicalJson), 'utf8') + 1,
      truncated: log.truncated
    }
  }
  const payload = Object.fromEntries(
    Object.entries(draft).filter(([key]) => key !== 'receiptChecksum')
  )
  return {
    receipt: {
      ...draft,
      receiptChecksum: sha256(canonicalJson(payload as unknown as CanonicalJson))
    },
    log
  }
}

const request = (
  value: ArtifactReproducibilityReceipt
): ExportArtifactReproducibilityReceiptRequest => ({
  projectId: value.artifactVersion.projectId,
  appSessionId: value.artifactVersion.appSessionId,
  artifactId: value.artifactVersion.artifactId,
  versionId: value.artifactVersion.versionId,
  receiptChecksum: value.receiptChecksum,
  suggestedName: 'results.csv'
})

const nativeLockContent = 'version = 1\n\n[[package]]\nname = "numpy"\nversion = "2.4.0"\n'
const poetryLockContent = '[[package]]\nname = "numpy"\nversion = "2.4.0"\n'
const pyprojectContent = '[project]\nname = "analysis"\nversion = "1.0.0"\n'
const condaExplicitLock =
  '@EXPLICIT\nhttps://repo.example.test/python-3.12.conda#0123456789abcdef0123456789abcdef\n'
const environmentLock: NotebookEnvironmentLock = {
  schemaVersion: 1,
  format: 'environment-lock-bundle',
  kernelKind: 'python',
  environmentName: 'default-python',
  components: [
    {
      ecosystem: 'conda',
      format: 'conda-explicit-md5',
      resolution: 'locked',
      explicitLock: condaExplicitLock,
      packages: ['python']
    },
    {
      ecosystem: 'python',
      format: 'uv-lock',
      resolution: 'locked',
      files: [
        {
          path: 'uv.lock',
          checksum: sha256(nativeLockContent),
          content: nativeLockContent
        },
        {
          path: 'pyproject.toml',
          checksum: sha256(pyprojectContent),
          content: pyprojectContent
        }
      ]
    },
    {
      ecosystem: 'python',
      format: 'poetry-lock',
      resolution: 'locked',
      files: [
        {
          path: 'poetry.lock',
          checksum: sha256(poetryLockContent),
          content: poetryLockContent
        },
        {
          path: 'pyproject.toml',
          checksum: sha256(pyprojectContent),
          content: pyprojectContent
        }
      ]
    }
  ]
}
const environmentLockContents = `${JSON.stringify(environmentLock, null, 2)}\n`

const environmentLockChecksum = sha256(environmentLockContents)
const condaOnlyEnvironmentLock: NotebookEnvironmentLock = {
  ...environmentLock,
  components: [environmentLock.components[0]!]
}
const condaOnlyEnvironmentLockContents = `${JSON.stringify(condaOnlyEnvironmentLock, null, 2)}\n`
const condaOnlyEnvironmentLockChecksum = sha256(condaOnlyEnvironmentLockContents)
const environmentLockRequest: ExportArtifactEnvironmentLockRequest = {
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  lockChecksum: environmentLockChecksum
}
const environmentLockExecution = {
  runs: [
    {
      runId: 'run-1',
      kernelKind: 'python',
      environmentName: 'default-python',
      environmentLock: {
        state: 'available',
        format: 'environment-lock-bundle',
        lockChecksum: environmentLockChecksum
      }
    }
  ],
  reproducibilityRecipe: {
    environmentRequirements: [
      {
        requirementId: `environment-lock:${environmentLockChecksum}`,
        kernelKind: 'python',
        environmentName: 'default-python',
        lockChecksum: environmentLockChecksum,
        lockState: 'available'
      }
    ]
  }
} as PersistedArtifactExecutionSnapshot

describe('Artifact reproducibility verification export', () => {
  it('returns browser-readable TIFF originals and differences on demand', async () => {
    const original = await sharp({
      create: { width: 10, height: 10, channels: 3, background: 'white' }
    })
      .tiff({ compression: 'none' })
      .toBuffer()
    const actual = await sharp(original).negate().tiff({ compression: 'lzw' }).toBuffer()
    const { report } = await compareReproducedContent({
      filename: 'plot.tiff',
      expected: original,
      actual
    })
    const value = receipt()
    value.schemaVersion = 2
    value.comparisons = [
      {
        ...value.comparisons[0]!,
        relativePath: 'plot.tiff',
        expectedChecksum: sha256(original),
        actualChecksum: sha256(actual),
        expectedSizeBytes: original.length,
        actualSizeBytes: actual.length,
        reason: 'size-mismatch',
        outputCaptured: true,
        contentComparison: report
      }
    ]
    const payload = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'receiptChecksum')
    )
    value.receiptChecksum = sha256(canonicalJson(payload as CanonicalJson))
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory: () => '/downloads',
      readReceipt: async () => value,
      readOutput: async () => actual,
      readOriginalOutput: async () => original,
      showSaveDialog: async () => ({ canceled: true })
    })
    const preview = await exporter.previewOutput({
      projectId: value.artifactVersion.projectId,
      appSessionId: value.artifactVersion.appSessionId,
      artifactId: value.artifactVersion.artifactId,
      versionId: value.artifactVersion.versionId,
      receiptChecksum: value.receiptChecksum,
      entityId: 'file-1'
    })
    expect(preview.original).toMatchObject({
      kind: 'image',
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/u)
    })
    expect(preview.reproduced).toMatchObject({
      kind: 'image',
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/u)
    })
    expect(preview.differenceImage).toMatch(/^data:image\/png;base64,/u)
  })
  it('includes content comparison coverage and a display version without modifying the receipt', () => {
    const value = receipt()
    value.comparisons[0]!.contentComparisonUnavailableReason = 'budget-exceeded'
    const original = structuredClone(value)
    const files = unzipSync(buildVerificationArchive(value, undefined, {}, false, 3))
    const report = strFromU8(files['report.md']!)
    expect(report).toContain('Version: v3')
    expect(report).toContain(`Version ID: ${value.artifactVersion.versionId}`)
    expect(report).toContain('Content comparisons')
    expect(report).toContain('Unavailable | budget-exceeded')
    expect(JSON.parse(strFromU8(files['verification-receipt.json']!))).toEqual(original)
    expect(buildVerificationReport(value)).not.toContain('Version: v')
  })

  it.each(['versionId', 'artifactId', 'checksum'] as const)(
    'rejects a report display version with a mismatched %s',
    async (field) => {
      const value = receipt()
      const writeArchive = vi.fn()
      const exporter = createArtifactReproducibilityReceiptExporter({
        downloadsDirectory: () => '/downloads',
        readReceipt: async () => value,
        readVersion: async () => ({
          versionId: value.artifactVersion.versionId,
          artifactId: value.artifactVersion.artifactId,
          checksum: value.artifactVersion.targetChecksum,
          versionNumber: 3,
          [field]: 'wrong'
        }),
        showSaveDialog: async () => ({ canceled: false, filePath: '/exports/record.zip' }),
        writeArchive
      })
      await expect(exporter.export(undefined, request(value))).rejects.toThrow('version identity')
      expect(writeArchive).not.toHaveBeenCalled()
    }
  )
  it('resolves the downloads directory only when a save dialog needs it', async () => {
    const value = receipt()
    const downloadsDirectory = vi.fn(() => '/downloads')
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory,
      readReceipt: async () => value,
      readVersion: async () => ({
        versionId: value.artifactVersion.versionId,
        artifactId: value.artifactVersion.artifactId,
        checksum: value.artifactVersion.targetChecksum,
        versionNumber: 3
      }),
      showSaveDialog: async () => ({ canceled: true })
    })
    expect(downloadsDirectory).not.toHaveBeenCalled()
    await expect(exporter.export(undefined, request(value))).resolves.toEqual({ saved: false })
    expect(downloadsDirectory).toHaveBeenCalledTimes(1)
  })
  it('previews and exports receipt-bound bytes, with original output remaining optional', async () => {
    const current = receipt()
    const bytes = Buffer.from('group,n\nCtrl,34\n')
    const payload = {
      ...current,
      comparisons: current.comparisons.map((comparison) => ({
        ...comparison,
        outputCaptured: true as const,
        actualChecksum: sha256(bytes),
        actualSizeBytes: bytes.length
      }))
    }
    const value = {
      ...payload,
      receiptChecksum: sha256(
        canonicalJson(
          Object.fromEntries(
            Object.entries(payload).filter(([key]) => key !== 'receiptChecksum')
          ) as unknown as CanonicalJson
        )
      )
    }
    const writeArchive = vi
      .fn<(path: string, contents: Uint8Array) => Promise<void>>()
      .mockResolvedValue(undefined)
    const readOutput = vi.fn(async () => bytes)
    const readOriginalOutput = vi.fn(async () => Buffer.from('group,n\nCtrl,33\n'))
    const readOutputStorage = vi.fn(async () => ({
      sizeBytes: bytes.length,
      fileCount: 1,
      clearedReceiptChecksums: [] as string[]
    }))
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory: () => '/downloads',
      readReceipt: async () => value,
      readOutput,
      readOriginalOutput,
      readOutputStorage,
      showSaveDialog: async () => ({ canceled: false, filePath: '/exports/selected' }),
      writeArchive
    })
    const scope = {
      projectId: current.artifactVersion.projectId,
      appSessionId: current.artifactVersion.appSessionId,
      artifactId: current.artifactVersion.artifactId,
      versionId: current.artifactVersion.versionId,
      receiptChecksum: value.receiptChecksum
    }
    await expect(exporter.previewOutput({ ...scope, entityId: 'file-1' })).resolves.toMatchObject({
      reproduced: { kind: 'text', text: bytes.toString() },
      original: { kind: 'text', text: 'group,n\nCtrl,33\n' }
    })
    await expect(exporter.previewOutput({ ...scope, entityId: 'unrelated' })).rejects.toThrow(
      'unavailable'
    )
    await expect(
      exporter.previewOutput({ ...scope, versionId: 'other', entityId: 'file-1' })
    ).rejects.toThrow()
    await expect(
      exporter.previewOutput({ ...scope, entityId: 'file-1', path: '/private/file' } as never)
    ).rejects.toThrow('Invalid')
    await exporter.export(undefined, { ...request(value), outputEntityId: 'file-1' })
    expect(writeArchive).toHaveBeenLastCalledWith('/exports/selected', bytes)
    await exporter.export(undefined, request(value))
    const files = unzipSync(writeArchive.mock.calls.at(-1)![1])
    expect(Buffer.from(files['outputs/1/report-draft.csv']!)).toEqual(bytes)
    expect(JSON.parse(strFromU8(files['outputs/manifest.json']!))).toEqual([
      {
        entityId: 'file-1',
        relativePath: 'results/report|draft.csv',
        archivePath: 'outputs/1/report-draft.csv'
      }
    ])
    expect(strFromU8(files['report.md']!)).toContain('Retained differing outputs')
    readOriginalOutput.mockRejectedValueOnce(new Error('original missing'))
    await expect(exporter.previewOutput({ ...scope, entityId: 'file-1' })).resolves.toMatchObject({
      reproduced: { kind: 'text' }
    })
    readOutputStorage.mockResolvedValue({
      sizeBytes: 0,
      fileCount: 0,
      clearedReceiptChecksums: [value.receiptChecksum]
    })
    readOutput.mockClear()
    await exporter.export(undefined, request(value))
    const clearedFiles = unzipSync(writeArchive.mock.calls.at(-1)![1])
    expect(Object.keys(clearedFiles).some((path) => path.startsWith('outputs/'))).toBe(false)
    expect(strFromU8(clearedFiles['report.md']!)).toContain('cleared by the user')
    expect(JSON.parse(strFromU8(clearedFiles['verification-receipt.json']!))).toEqual(value)
    expect(JSON.parse(strFromU8(clearedFiles['output-retention.json']!))).toEqual({
      state: 'cleared',
      receiptChecksum: value.receiptChecksum
    })
    expect(readOutput).not.toHaveBeenCalled()
    await expect(
      exporter.export(undefined, { ...request(value), outputEntityId: 'file-1' })
    ).rejects.toThrow('cleared')
  })
  it('builds a deterministic archive with the exact receipt and a readable report', () => {
    const { receipt: value, log } = receiptWithCheckLog()
    const first = buildVerificationArchive(value, log)
    const second = buildVerificationArchive(value, log)
    const files = unzipSync(first)

    expect(first).toEqual(second)
    expect(Object.keys(files)).toEqual([
      'report.md',
      'verification-receipt.json',
      'execution-log.json'
    ])
    expect(JSON.parse(strFromU8(files['execution-log.json']!))).toEqual(log)
    expect(JSON.parse(strFromU8(files['verification-receipt.json']!))).toEqual(value)
    expect(strFromU8(files['report.md']!)).toContain('**Result differs**')
    expect(strFromU8(files['report.md']!)).toContain('results/report\\|draft.csv')
    expect(strFromU8(files['report.md']!)).toContain(value.receiptChecksum)
    expect(buildVerificationReport(value)).not.toContain('/Users/')
  })

  it('reloads and validates the selected receipt before saving', async () => {
    const { receipt: value, log } = receiptWithCheckLog()
    const writeArchive = vi.fn<(path: string, bytes: Uint8Array) => Promise<void>>(
      async () => undefined
    )
    const showSaveDialog = vi.fn(async () => ({
      canceled: false,
      filePath: '/exports/verification'
    }))
    const readReceipt = vi.fn(async () => value)
    const readCheckLog = vi.fn(async () => log)
    const readVersion = vi.fn(async () => ({
      versionId: value.artifactVersion.versionId,
      artifactId: value.artifactVersion.artifactId,
      checksum: value.artifactVersion.targetChecksum,
      versionNumber: 3
    }))
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory: () => '/downloads',
      readReceipt,
      readCheckLog,
      readVersion,
      showSaveDialog,
      writeArchive
    })

    await expect(exporter.export({ window: 1 }, request(value))).resolves.toEqual({ saved: true })
    expect(readVersion).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: value.artifactVersion.versionId })
    )
    const saved = unzipSync(writeArchive.mock.calls[0]![1])
    expect(strFromU8(saved['report.md']!)).toContain('Version: v3')
    expect(JSON.parse(strFromU8(saved['verification-receipt.json']!))).toEqual(value)
    expect(readReceipt).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      },
      value.receiptChecksum
    )
    expect(readCheckLog).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      receiptChecksum: value.receiptChecksum
    })
    expect(showSaveDialog).toHaveBeenCalledWith(
      { window: 1 },
      expect.objectContaining({
        defaultPath: `/downloads/${verificationArchiveName('results.csv', value.completedAt)}`
      })
    )
    expect(writeArchive).toHaveBeenCalledWith('/exports/verification.zip', expect.any(Uint8Array))
  })

  it('fails closed when a receipt references a missing check log', async () => {
    const { receipt: value } = receiptWithCheckLog()
    const showSaveDialog = vi.fn()
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory: () => '/downloads',
      readReceipt: vi.fn(async () => value),
      readCheckLog: vi.fn(async () => undefined),
      showSaveDialog,
      writeArchive: vi.fn()
    })

    await expect(exporter.export(undefined, request(value))).rejects.toThrow(
      'Reproducibility check log was not found.'
    )
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('writes nothing when the save dialog is cancelled', async () => {
    const value = receipt()
    const writeArchive = vi.fn()
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory: () => '/downloads',
      readReceipt: vi.fn(async () => value),
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      writeArchive
    })

    await expect(exporter.export(undefined, request(value))).resolves.toEqual({ saved: false })
    expect(writeArchive).not.toHaveBeenCalled()
  })

  it('rejects missing, cross-version, and modified receipts', async () => {
    const value = receipt()
    const showSaveDialog = vi.fn()
    const create = (
      value: ArtifactReproducibilityReceipt | undefined
    ): ReturnType<typeof createArtifactReproducibilityReceiptExporter> =>
      createArtifactReproducibilityReceiptExporter({
        downloadsDirectory: () => '/downloads',
        readReceipt: vi.fn(async () => value),
        showSaveDialog,
        writeArchive: vi.fn()
      })

    await expect(create(undefined).export(undefined, request(value))).rejects.toThrow(
      'Reproducibility receipt was not found.'
    )
    await expect(
      create({
        ...value,
        artifactVersion: { ...value.artifactVersion, versionId: 'version-2' }
      }).export(undefined, request(value))
    ).rejects.toThrow('Reproducibility receipt identity mismatch.')
    await expect(
      create({ ...value, outcome: 'matched' }).export(undefined, request(value))
    ).rejects.toThrow('Reproducibility receipt checksum mismatch')
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('rejects unexpected export request fields at the IPC trust boundary', async () => {
    const value = receipt()
    const readReceipt = vi.fn()
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory: () => '/downloads',
      readReceipt,
      showSaveDialog: vi.fn(),
      writeArchive: vi.fn()
    })

    await expect(
      exporter.export(undefined, { ...request(value), receipt: value } as never)
    ).rejects.toThrow('Invalid reproducibility receipt export request.')
    expect(readReceipt).not.toHaveBeenCalled()
  })

  it('sanitizes portable archive names', () => {
    expect(verificationArchiveName('C:\\private\\CON.csv', '2026-09-02T00:01:02.345Z')).toBe(
      'artifact-CON-verification-20260902T000102Z.zip'
    )
    expect(verificationArchiveName('../plot.png', '2026-09-02T00:01:02.345Z')).toBe(
      'plot-verification-20260902T000102Z.zip'
    )
  })
})

describe('Artifact Environment lock export', () => {
  it('preserves the run scope and omitted packages in exported lock evidence', () => {
    const lock = { ...condaOnlyEnvironmentLock, omittedPackages: ['python:pandas'] }
    const serialized = JSON.stringify(lock)
    const files = unzipSync(buildEnvironmentLockArchive(lock, serialized))
    expect(JSON.parse(strFromU8(files['environment-lock.json']!)).omittedPackages).toEqual([
      'python:pandas'
    ])
    expect(strFromU8(files['README.md']!)).toContain(
      'Installed but unused packages omitted from this lock: python:pandas.'
    )
    expect(strFromU8(files['README.md']!)).toContain(
      'full installed inventory is retained separately'
    )
  })

  it('builds a deterministic archive with standard tool lock files', () => {
    const first = buildEnvironmentLockArchive(environmentLock, environmentLockContents)
    const second = buildEnvironmentLockArchive(environmentLock, environmentLockContents)
    const files = unzipSync(first)

    expect(first).toEqual(second)
    expect(Object.keys(files)).toEqual([
      'environment-lock.json',
      'bundle-manifest.json',
      'README.md',
      'conda-explicit.txt',
      'uv.lock',
      'pyproject.toml',
      'poetry.lock'
    ])
    expect(strFromU8(files['environment-lock.json']!)).toBe(environmentLockContents)
    expect(strFromU8(files['conda-explicit.txt']!)).toBe(condaExplicitLock)
    expect(strFromU8(files['uv.lock']!)).toBe(nativeLockContent)
    expect(strFromU8(files['pyproject.toml']!)).toBe(pyprojectContent)
    expect(strFromU8(files['poetry.lock']!)).toBe(poetryLockContent)
    expect(JSON.parse(strFromU8(files['bundle-manifest.json']!))).toMatchObject({
      lockChecksum: environmentLockChecksum,
      lockState: 'available',
      packageManagers: ['conda', 'uv', 'poetry']
    })
    expect(strFromU8(files['README.md']!)).toContain('micromamba create')
    // These project locks are included as evidence; the Conda baseline already covers this run.
    expect(strFromU8(files['README.md']!)).not.toContain('uv sync')
    expect(strFromU8(files['README.md']!)).not.toContain('poetry install')
  })

  it.each([
    {
      format: 'uv-lock',
      ecosystem: 'python',
      tool: 'uv',
      path: 'uv.lock',
      content: nativeLockContent,
      command: 'uv sync --locked',
      binding: 'UV_PROJECT_ENVIRONMENT="$reproduced_prefix"'
    },
    {
      format: 'poetry-lock',
      ecosystem: 'python',
      tool: 'poetry',
      path: 'poetry.lock',
      content: poetryLockContent,
      command: 'poetry install --no-root',
      binding: 'VIRTUAL_ENV="$reproduced_prefix" POETRY_VIRTUALENVS_CREATE=false'
    },
    {
      format: 'pip-requirements',
      ecosystem: 'python',
      tool: 'pip',
      path: 'requirements.lock',
      content: `numpy==2.4.0 --hash=sha256:${'a'.repeat(64)}\n`,
      command: 'python -I -m pip --isolated install --require-hashes --force-reinstall --no-deps',
      binding: "-r 'requirements.lock'"
    },
    {
      format: 'renv-lock',
      ecosystem: 'r',
      tool: 'r-renv',
      path: 'renv.lock',
      content: JSON.stringify({
        Packages: { numpy: { Package: 'numpy', Version: '2.4.0', Source: 'Repository' } }
      }),
      command: 'Rscript --vanilla',
      binding: 'library=R.home("library")'
    },
    {
      format: 'pak-lock',
      ecosystem: 'r',
      tool: 'r-pak',
      path: 'pkg.lock',
      content: JSON.stringify({ packages: [{ package: 'numpy', version: '2.4.0' }] }),
      command: 'Rscript --vanilla',
      binding: 'lib=R.home("library")'
    }
  ] as const)(
    'binds $format restoration to the restored prefix and nested primary lock directory',
    (entry) => {
      const lock: NotebookEnvironmentLock = {
        ...environmentLock,
        kernelKind: entry.ecosystem,
        untrackedPackages: [`${entry.ecosystem}:numpy`],
        components: [
          {
            ecosystem: 'conda',
            format: 'conda-explicit-md5',
            resolution: 'locked',
            explicitLock: condaExplicitLock,
            packages: [entry.tool]
          },
          {
            ...(entry.ecosystem === 'python'
              ? { ecosystem: entry.ecosystem, format: entry.format }
              : { ecosystem: entry.ecosystem, format: entry.format }),
            resolution: 'locked',
            files: [
              {
                path: `locks/project's data/${entry.path}`,
                content: entry.content,
                checksum: sha256(entry.content)
              }
            ]
          }
        ]
      }
      const readme = strFromU8(
        unzipSync(buildEnvironmentLockArchive(lock, JSON.stringify(lock)))['README.md']!
      )
      expect(readme).toContain(
        'micromamba create --prefix "$reproduced_prefix" --file "$bundle_root/conda-explicit.txt"'
      )
      expect(readme).toContain(`cd "$bundle_root"/'locks/project'"'"'s data'`)
      expect(readme).toContain('micromamba run --prefix "$reproduced_prefix"')
      expect(readme).toContain(entry.command)
      expect(readme).toContain(entry.binding)
      if (entry.format === 'renv-lock') {
        expect(readme).toContain('names(formals(renv::restore))')
        expect(readme).toContain('if ("retry" %in% restore_formals) restore_args$retry <- FALSE')
        expect(readme).toContain('if ("strict" %in% restore_formals) restore_args$strict <- TRUE')
      }
    }
  )

  it('selects only the restorable native component and prefers requirements.lock', () => {
    const content = `numpy==2.4.0 --hash=sha256:${'a'.repeat(64)}\n`
    const lock: NotebookEnvironmentLock = {
      ...environmentLock,
      untrackedPackages: ['python:numpy'],
      components: [
        {
          ecosystem: 'conda',
          format: 'conda-explicit-md5',
          resolution: 'locked',
          explicitLock: condaExplicitLock,
          packages: ['python', 'pip', 'uv', 'poetry']
        },
        {
          ecosystem: 'python',
          format: 'pip-requirements',
          resolution: 'locked',
          files: ['requirements.txt', 'requirements.lock'].map((path) => ({
            path: `nested/${path}`,
            content,
            checksum: sha256(content)
          }))
        },
        ...environmentLock.components.slice(1)
      ]
    }
    const readme = strFromU8(
      unzipSync(buildEnvironmentLockArchive(lock, JSON.stringify(lock)))['README.md']!
    )
    expect(readme).toContain("-r 'requirements.lock'")
    expect(readme).not.toContain("-r 'requirements.txt'")
    expect(readme).not.toContain('uv sync')
    expect(readme).not.toContain('poetry install')
  })

  it('documents partial bundles as inspection-only', () => {
    expect(
      buildEnvironmentLockReadme({
        schemaVersion: 1,
        format: 'open-science-environment-lock-export',
        lockChecksum: environmentLockChecksum,
        lockState: 'partial',
        kernelKind: 'python',
        environmentName: 'default-python',
        packageManagers: ['conda']
      })
    ).toContain('inspection only')
  })

  it('rejects conflicting standard lock files instead of overwriting them', () => {
    const conflicting = structuredClone(environmentLock)
    const poetry = conflicting.components.find((component) => component.format === 'poetry-lock')
    if (!poetry || poetry.ecosystem !== 'python') throw new Error('Missing Poetry fixture')
    const pyproject = poetry.files.find((file) => file.path === 'pyproject.toml')
    if (!pyproject) throw new Error('Missing pyproject fixture')
    pyproject.content = `${pyproject.content}description = "different"\n`
    pyproject.checksum = sha256(pyproject.content)

    expect(() => buildEnvironmentLockArchive(conflicting, environmentLockContents)).toThrow(
      'Environment lock archive path conflicts: pyproject.toml'
    )
  })

  it('exports the exact validated lock referenced by the Artifact dependency recipe', async () => {
    const readExecution = vi.fn(async () => environmentLockExecution)
    const readEnvironmentLock = vi.fn(async () => environmentLockContents)
    const showSaveDialog = vi.fn(async () => ({
      canceled: false,
      filePath: '/exports/environment-lock'
    }))
    const writeArchive = vi.fn(async () => undefined)
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory: () => '/downloads',
      readReceipt: vi.fn(),
      readExecution,
      readEnvironmentLock,
      showSaveDialog,
      writeArchive
    })

    await expect(
      exporter.exportEnvironmentLock({ window: 1 }, environmentLockRequest)
    ).resolves.toEqual({ saved: true })
    expect(readExecution).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    })
    expect(readEnvironmentLock).toHaveBeenCalledWith(environmentLockChecksum)
    expect(showSaveDialog).toHaveBeenCalledWith(
      { window: 1 },
      expect.objectContaining({
        defaultPath: `/downloads/environment-lock-${environmentLockChecksum}.zip`
      })
    )
    expect(writeArchive).toHaveBeenCalledWith(
      '/exports/environment-lock.zip',
      expect.any(Uint8Array)
    )
  })

  it('rejects unreferenced and modified locks before showing the save dialog', async () => {
    const showSaveDialog = vi.fn()
    const create = (
      execution: PersistedArtifactExecutionSnapshot,
      contents?: string
    ): ReturnType<typeof createArtifactReproducibilityReceiptExporter> =>
      createArtifactReproducibilityReceiptExporter({
        downloadsDirectory: () => '/downloads',
        readReceipt: vi.fn(),
        readExecution: vi.fn(async () => execution),
        readEnvironmentLock: vi.fn(async () => contents),
        showSaveDialog,
        writeArchive: vi.fn()
      })

    await expect(
      create({
        ...environmentLockExecution,
        reproducibilityRecipe: {
          ...environmentLockExecution.reproducibilityRecipe!,
          environmentRequirements: []
        }
      }).exportEnvironmentLock(undefined, environmentLockRequest)
    ).rejects.toThrow('Environment lock is not referenced by this Artifact dependency recipe.')
    await expect(
      create(environmentLockExecution, `${environmentLockContents} `).exportEnvironmentLock(
        undefined,
        environmentLockRequest
      )
    ).rejects.toThrow('Environment lock checksum mismatch.')
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('imports a complete validated bundle into a checksum-named environment', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'environment-lock-import-'))
    const archivePath = join(directory, 'environment-lock.zip')
    writeFileSync(
      archivePath,
      buildEnvironmentLockArchive(condaOnlyEnvironmentLock, condaOnlyEnvironmentLockContents)
    )
    const createEnvironmentFromLock = vi.fn(async () => ({
      environmentName: `repro-${condaOnlyEnvironmentLockChecksum.slice(0, 12)}`,
      reused: false
    }))
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory: () => '/downloads',
      readReceipt: vi.fn(),
      showSaveDialog: vi.fn(),
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [archivePath] })),
      createEnvironmentFromLock
    })

    try {
      await expect(exporter.importEnvironmentLock(undefined, {})).resolves.toEqual({
        imported: true,
        environmentName: `repro-${condaOnlyEnvironmentLockChecksum.slice(0, 12)}`,
        kernelKind: 'python',
        reused: false
      })
      expect(createEnvironmentFromLock).toHaveBeenCalledWith({
        lockChecksum: condaOnlyEnvironmentLockChecksum,
        kernelKind: 'python',
        lock: condaOnlyEnvironmentLock
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('creates a reusable environment directly from the Artifact captured lock', async () => {
    const createEnvironmentFromLock = vi.fn(async () => ({
      environmentName: `repro-${environmentLockChecksum.slice(0, 12)}`,
      reused: false
    }))
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory: () => '/downloads',
      readReceipt: vi.fn(),
      readExecution: vi.fn(async () => environmentLockExecution),
      readEnvironmentLock: vi.fn(async () => environmentLockContents),
      showSaveDialog: vi.fn(),
      createEnvironmentFromLock
    })

    await expect(exporter.createEnvironmentFromLock(environmentLockRequest)).resolves.toEqual({
      environmentName: `repro-${environmentLockChecksum.slice(0, 12)}`,
      kernelKind: 'python',
      reused: false
    })
    expect(createEnvironmentFromLock).toHaveBeenCalledWith({
      projectId: 'project-1',
      lockChecksum: environmentLockChecksum,
      kernelKind: 'python',
      lock: environmentLock
    })
  })

  it('refuses partial and wrong-platform bundles before creating an environment', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'environment-lock-import-'))
    const archivePath = join(directory, 'environment-lock.zip')
    const createEnvironmentFromLock = vi.fn(async () => ({
      environmentName: `repro-${environmentLockChecksum.slice(0, 12)}`,
      reused: false
    }))
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [archivePath] }))
    const exporter = createArtifactReproducibilityReceiptExporter({
      downloadsDirectory: () => '/downloads',
      readReceipt: vi.fn(),
      showSaveDialog: vi.fn(),
      showOpenDialog,
      createEnvironmentFromLock
    })
    const info = {
      schemaVersion: 1 as const,
      format: 'open-science-environment-lock-export' as const,
      lockChecksum: environmentLockChecksum,
      lockState: 'partial' as const,
      kernelKind: 'python' as const,
      environmentName: 'default-python',
      packageManagers: ['conda' as const, 'uv' as const, 'poetry' as const]
    }

    try {
      writeFileSync(
        archivePath,
        buildEnvironmentLockArchive(environmentLock, environmentLockContents, info)
      )
      await expect(
        exporter.importEnvironmentLock(undefined, { projectId: 'project-2' })
      ).rejects.toThrow('partial Environment lock')

      writeFileSync(
        archivePath,
        buildEnvironmentLockArchive(environmentLock, environmentLockContents, {
          ...info,
          lockState: 'available'
        })
      )
      await expect(
        exporter.importEnvironmentLock(undefined, { projectId: 'project-2' })
      ).resolves.toMatchObject({
        imported: true,
        environmentName: `repro-${environmentLockChecksum.slice(0, 12)}`
      })

      const wrongPlatformLock = {
        ...condaOnlyEnvironmentLock,
        platform: process.platform === 'darwin' ? 'linux' : 'darwin'
      }
      const wrongPlatformContents = `${JSON.stringify(wrongPlatformLock, null, 2)}\n`
      writeFileSync(
        archivePath,
        buildEnvironmentLockArchive(wrongPlatformLock, wrongPlatformContents, {
          ...info,
          lockChecksum: sha256(wrongPlatformContents),
          lockState: 'available',
          platform: wrongPlatformLock.platform,
          packageManagers: ['conda']
        })
      )
      await expect(
        exporter.importEnvironmentLock(undefined, { projectId: 'project-2' })
      ).rejects.toThrow('platform does not match')
      expect(createEnvironmentFromLock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
