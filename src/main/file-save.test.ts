import { beforeEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const downloadsPath = join('/Users/example', 'Downloads')
const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
const getAppPath = vi.hoisted(() => vi.fn())
const showSaveDialog = vi.hoisted(() => vi.fn())
const showOpenDialog = vi.hoisted(() => vi.fn())
const zipSyncMock = vi.hoisted(() => vi.fn())

vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>()
  return {
    ...actual,
    zipSync: (...args: Parameters<typeof actual.zipSync>) => {
      zipSyncMock()
      return actual.zipSync(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: getAppPath },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showOpenDialog, showSaveDialog },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const { registerFileSaveHandlers: registerProductionFileSaveHandlers } = await import('./file-save')
const { publishUserFile: productionPublishUserFile } = await import('./user-file-publisher')
const publishDirectly: typeof productionPublishUserFile = async (
  destinationPath,
  write,
  options
) => {
  await options?.validateDestination?.()
  await write(destinationPath)
}
const registerFileSaveHandlers = (
  options: NonNullable<Parameters<typeof registerProductionFileSaveHandlers>[0]> = {}
): void => {
  const openManagedFileVersion = options.openManagedFileVersion ?? options.openLatestManagedFile
  registerProductionFileSaveHandlers({
    ...options,
    ...(openManagedFileVersion ? { openManagedFileVersion } : {}),
    publishUserFile: options.publishUserFile ?? publishDirectly
  })
}

type TestManagedVersionHandle = {
  size: number
  readRange: (begin: number, end: number) => Promise<Uint8Array>
  verifyUnchanged: () => Promise<void>
  copyTo: (destinationPath: string, options?: { exclusive?: boolean }) => Promise<void>
  close: () => Promise<void>
}

const managedVersionHandle = (
  content: string | Uint8Array,
  overrides: Partial<TestManagedVersionHandle> = {}
): TestManagedVersionHandle => {
  const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content)
  return {
    size: bytes.byteLength,
    readRange: async (begin, end) => bytes.subarray(begin, end),
    verifyUnchanged: async () => undefined,
    copyTo: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

const fileBackedManagedVersionHandle = async (
  sourcePath: string
): Promise<TestManagedVersionHandle> =>
  managedVersionHandle(await readFile(sourcePath), {
    copyTo: vi.fn(async (destinationPath, options) =>
      copyFile(sourcePath, destinationPath, options?.exclusive ? constants.COPYFILE_EXCL : 0)
    )
  })

type TestFileSaveOptions = Omit<
  NonNullable<Parameters<typeof registerProductionFileSaveHandlers>[0]>,
  'resolveManagedFilePath'
> & {
  resolveManagedFilePath?: (
    source: 'artifact' | 'upload',
    request: { path: string; projectId?: string; fileId?: string }
  ) => Promise<string | { path: string }>
  resolveSessionArtifactFilePath?: (
    projectId: string,
    sessionId: string,
    path: string
  ) => Promise<string>
}

// Older archive fixtures use temporary source paths. Adapt those fixtures to the production
// latest-version lease boundary without restoring a path fallback in the handler itself.
const registerProjectFileSaveHandlers = (options: TestFileSaveOptions = {}): void => {
  const { resolveManagedFilePath, resolveSessionArtifactFilePath, ...productionOptions } = options
  const openManagedFileVersion =
    options.openManagedFileVersion ??
    options.openLatestManagedFile ??
    (resolveSessionArtifactFilePath || resolveManagedFilePath
      ? async (source: 'artifact' | 'upload', request: { projectId: string; fileId: string }) => {
          const resolved =
            source === 'upload'
              ? await resolveManagedFilePath?.(source, {
                  path: request.fileId,
                  projectId: request.projectId,
                  fileId: request.fileId
                })
              : await resolveSessionArtifactFilePath?.(
                  request.projectId,
                  'test-session',
                  request.fileId
                )
          if (!resolved) throw new Error('Test managed Version fixture is unavailable.')
          const sourcePath = typeof resolved === 'string' ? resolved : resolved.path
          return managedVersionHandle(await readFile(sourcePath))
        }
      : undefined)

  registerFileSaveHandlers({
    ...productionOptions,
    ...(openManagedFileVersion ? { openManagedFileVersion } : {})
  })
}

describe('file save IPC handlers', () => {
  beforeEach(() => {
    handlers.clear()
    getAppPath.mockReset()
    getAppPath.mockReturnValue(downloadsPath)
    showOpenDialog.mockReset()
    showSaveDialog.mockReset()
    zipSyncMock.mockClear()
  })

  it('exports one selected Session Artifact through Save As', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-session-artifact-'))
    const sourcePath = join(root, 'managed-report.csv')
    const destinationPath = join(root, 'downloaded-report.csv')
    await writeFile(sourcePath, 'artifact bytes')
    const openLatestManagedFile = vi
      .fn()
      .mockResolvedValue(await fileBackedManagedVersionHandle(sourcePath))
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({ openLatestManagedFile } as never)

    try {
      const result = await handlers.get('file:save-session-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          files: [
            {
              fileId: 'artifact-report',
              versionId: 'artifact-report-version',
              suggestedName: 'report.csv'
            }
          ]
        }
      )

      expect(openLatestManagedFile).toHaveBeenCalledWith('artifact', {
        projectId: 'project-1',
        fileId: 'artifact-report',
        versionId: 'artifact-report-version'
      })
      expect(showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: join(downloadsPath, 'report.csv'),
          title: 'Save artifact'
        })
      )
      expect(result).toEqual({ saved: true, filePaths: [destinationPath] })
      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('artifact bytes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('opens the immutable Session Artifact Version selected in the renderer snapshot', async () => {
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openLatestManagedFile = vi.fn()
    const openManagedFileVersion = vi.fn().mockResolvedValue({ copyTo, close })
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'report.csv')
    })
    registerFileSaveHandlers({ openLatestManagedFile, openManagedFileVersion } as never)

    await handlers.get('file:save-session-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        files: [
          {
            fileId: 'artifact-report',
            versionId: 'artifact-version-1',
            suggestedName: 'report.csv'
          }
        ]
      }
    )

    expect(openManagedFileVersion).toHaveBeenCalledWith('artifact', {
      projectId: 'project-1',
      fileId: 'artifact-report',
      versionId: 'artifact-version-1'
    })
    expect(openLatestManagedFile).not.toHaveBeenCalled()
    expect(copyTo).toHaveBeenCalledWith(join(downloadsPath, 'report.csv'))
    expect(close).toHaveBeenCalledOnce()
  })

  it('exports multiple selected Session Artifacts after choosing one destination folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-session-artifacts-'))
    const sourceA = join(root, 'managed-a.csv')
    const sourceB = join(root, 'managed-b.png')
    const destinationDirectory = join(root, 'downloads')
    await writeFile(sourceA, 'artifact a')
    await writeFile(sourceB, 'artifact b')
    await mkdir(destinationDirectory)
    const openLatestManagedFile = vi
      .fn()
      .mockResolvedValueOnce(await fileBackedManagedVersionHandle(sourceA))
      .mockResolvedValueOnce(await fileBackedManagedVersionHandle(sourceB))
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({ openLatestManagedFile } as never)

    try {
      const result = await handlers.get('file:save-session-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          files: [
            { fileId: 'artifact-a', versionId: 'artifact-a-version', suggestedName: 'a.csv' },
            { fileId: 'artifact-b', versionId: 'artifact-b-version', suggestedName: 'b.png' }
          ]
        }
      )

      expect(showOpenDialog).toHaveBeenCalledTimes(1)
      expect(showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: downloadsPath,
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose where to save artifacts'
        })
      )
      expect(result).toEqual({
        saved: true,
        filePaths: [join(destinationDirectory, 'a.csv'), join(destinationDirectory, 'b.png')]
      })
      await expect(readFile(join(destinationDirectory, 'a.csv'), 'utf8')).resolves.toBe(
        'artifact a'
      )
      await expect(readFile(join(destinationDirectory, 'b.png'), 'utf8')).resolves.toBe(
        'artifact b'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps existing files and selected duplicate names when exporting multiple Artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-artifact-collisions-'))
    const sourceA = join(root, 'managed-a.csv')
    const sourceB = join(root, 'managed-b.csv')
    const destinationDirectory = join(root, 'downloads')
    await writeFile(sourceA, 'artifact a')
    await writeFile(sourceB, 'artifact b')
    await mkdir(destinationDirectory)
    await writeFile(join(destinationDirectory, 'report.csv'), 'existing download')
    const openLatestManagedFile = vi
      .fn()
      .mockResolvedValueOnce(await fileBackedManagedVersionHandle(sourceA))
      .mockResolvedValueOnce(await fileBackedManagedVersionHandle(sourceB))
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({ openLatestManagedFile } as never)

    try {
      const result = await handlers.get('file:save-session-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          files: [
            { fileId: 'artifact-a', versionId: 'artifact-a-version', suggestedName: 'report.csv' },
            { fileId: 'artifact-b', versionId: 'artifact-b-version', suggestedName: 'report.csv' }
          ]
        }
      )

      expect(result).toEqual({
        saved: true,
        filePaths: [
          join(destinationDirectory, 'report (2).csv'),
          join(destinationDirectory, 'report (3).csv')
        ]
      })
      await expect(readFile(join(destinationDirectory, 'report.csv'), 'utf8')).resolves.toBe(
        'existing download'
      )
      await expect(readFile(join(destinationDirectory, 'report (2).csv'), 'utf8')).resolves.toBe(
        'artifact a'
      )
      await expect(readFile(join(destinationDirectory, 'report (3).csv'), 'utf8')).resolves.toBe(
        'artifact b'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports one failed Artifact while keeping the other batch exports', async () => {
    const destinationDirectory = '/downloads/session-artifacts'
    const closeA = vi.fn().mockResolvedValue(undefined)
    const closeB = vi.fn().mockResolvedValue(undefined)
    const copyA = vi.fn().mockResolvedValue(undefined)
    const copyB = vi.fn().mockRejectedValue(new Error('disk full'))
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({
      openLatestManagedFile: vi
        .fn()
        .mockResolvedValueOnce({ copyTo: copyA, close: closeA })
        .mockResolvedValueOnce({ copyTo: copyB, close: closeB })
    } as never)

    const result = await handlers.get('file:save-session-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        files: [
          { fileId: 'artifact-a', versionId: 'artifact-a-version', suggestedName: 'a.csv' },
          { fileId: 'artifact-b', versionId: 'artifact-b-version', suggestedName: 'b.csv' }
        ]
      }
    )

    expect(result).toEqual({
      saved: true,
      filePaths: [join(destinationDirectory, 'a.csv')],
      failures: [
        {
          fileId: 'artifact-b',
          versionId: 'artifact-b-version',
          suggestedName: 'b.csv',
          message: 'disk full'
        }
      ]
    })
    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeB).toHaveBeenCalledTimes(1)
  })

  it('keeps exporting valid Artifacts when one selected source no longer resolves', async () => {
    const destinationDirectory = '/downloads/session-artifacts'
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({
      openLatestManagedFile: vi
        .fn()
        .mockRejectedValueOnce(new Error('Artifact no longer exists'))
        .mockResolvedValueOnce({ copyTo, close })
    } as never)

    const result = await handlers.get('file:save-session-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        files: [
          {
            fileId: 'artifact-missing',
            versionId: 'artifact-missing-version',
            suggestedName: 'missing.csv'
          },
          { fileId: 'artifact-b', versionId: 'artifact-b-version', suggestedName: 'b.csv' }
        ]
      }
    )

    expect(result).toEqual({
      saved: true,
      filePaths: [join(destinationDirectory, 'b.csv')],
      failures: [
        {
          fileId: 'artifact-missing',
          versionId: 'artifact-missing-version',
          suggestedName: 'missing.csv',
          message: 'Artifact no longer exists'
        }
      ]
    })
    expect(copyTo).toHaveBeenCalledWith(join(destinationDirectory, 'b.csv'), { exclusive: true })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('registers a managed-file save channel', () => {
    registerFileSaveHandlers()

    expect(handlers.has('file:save-managed')).toBe(true)
  })

  it('opens a trusted logical-file lease after Save As without reopening its resolved path', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/path-must-not-be-used.csv')
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openLatestManagedFile = vi.fn().mockResolvedValue({ copyTo, close })
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'report.csv')
    })
    registerFileSaveHandlers({ resolveManagedFilePath, openLatestManagedFile } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      {
        source: 'artifact',
        projectId: 'project-1',
        fileId: 'artifact-1',
        suggestedName: 'report.csv'
      }
    )

    expect(openLatestManagedFile).toHaveBeenCalledWith('artifact', {
      projectId: 'project-1',
      fileId: 'artifact-1'
    })
    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(copyTo).toHaveBeenCalledWith(join(downloadsPath, 'report.csv'))
    expect(close).toHaveBeenCalledOnce()
  })

  it('preserves an explicit historical version when exporting a logical managed file', async () => {
    const resolveManagedFilePath = vi.fn()
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openManagedFileVersion = vi.fn().mockResolvedValue({ copyTo, close })
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'report.csv')
    })
    registerFileSaveHandlers({ resolveManagedFilePath, openManagedFileVersion } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      {
        source: 'artifact',
        projectId: 'project-1',
        fileId: 'artifact-1',
        versionId: 'version-1',
        suggestedName: 'report.csv'
      }
    )

    expect(openManagedFileVersion).toHaveBeenCalledWith('artifact', {
      projectId: 'project-1',
      fileId: 'artifact-1',
      versionId: 'version-1'
    })
    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(copyTo).toHaveBeenCalledWith(join(downloadsPath, 'report.csv'))
    expect(close).toHaveBeenCalledOnce()
  })

  it('resolves every logical Session Artifact after the destination folder is chosen', async () => {
    const destinationDirectory = '/downloads/session-artifacts'
    const openLatestManagedFile = vi.fn().mockResolvedValue({
      copyTo: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    })
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({ openLatestManagedFile } as never)

    await handlers.get('file:save-session-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        files: [
          { fileId: 'artifact-a', versionId: 'artifact-a-version', suggestedName: 'a.csv' },
          { fileId: 'artifact-b', versionId: 'artifact-b-version', suggestedName: 'b.csv' }
        ]
      }
    )

    expect(openLatestManagedFile).toHaveBeenNthCalledWith(1, 'artifact', {
      projectId: 'project-1',
      fileId: 'artifact-a',
      versionId: 'artifact-a-version'
    })
    expect(openLatestManagedFile).toHaveBeenNthCalledWith(2, 'artifact', {
      projectId: 'project-1',
      fileId: 'artifact-b',
      versionId: 'artifact-b-version'
    })
  })

  it('exports each logical Session Artifact through its own trusted lease and closes every lease', async () => {
    const destinationDirectory = '/downloads/session-artifacts'
    const first = {
      copyTo: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    }
    const second = {
      copyTo: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    }
    const openLatestManagedFile = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const resolveManagedFilePath = vi.fn()
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({ resolveManagedFilePath, openLatestManagedFile } as never)

    await handlers.get('file:save-session-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        files: [
          { fileId: 'artifact-a', versionId: 'artifact-a-version', suggestedName: 'a.csv' },
          { fileId: 'artifact-b', versionId: 'artifact-b-version', suggestedName: 'b.csv' }
        ]
      }
    )

    expect(openLatestManagedFile).toHaveBeenNthCalledWith(1, 'artifact', {
      projectId: 'project-1',
      fileId: 'artifact-a',
      versionId: 'artifact-a-version'
    })
    expect(openLatestManagedFile).toHaveBeenNthCalledWith(2, 'artifact', {
      projectId: 'project-1',
      fileId: 'artifact-b',
      versionId: 'artifact-b-version'
    })
    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
  })

  it('passes an Upload logical identity to the source-neutral export resolver', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/upload-v3.csv')
    showSaveDialog.mockResolvedValue({ canceled: true })
    const openLatestManagedFile = vi.fn()
    registerFileSaveHandlers({ resolveManagedFilePath, openLatestManagedFile } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      {
        source: 'upload',
        projectId: 'project-1',
        fileId: 'upload-1',
        suggestedName: 'study.csv'
      }
    )

    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(openLatestManagedFile).not.toHaveBeenCalled()
  })

  it('rejects a path-only Upload download instead of bypassing the logical-file authority', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/canonical-report.csv')
    const openManagedFile = vi.fn()
    registerFileSaveHandlers({ resolveManagedFilePath, openManagedFile })

    await expect(
      handlers.get('file:save-managed')!({ sender: {} }, {
        source: 'upload',
        path: '/managed/requested-report.csv',
        suggestedName: '../report.csv'
      } as never)
    ).rejects.toThrow(/logical identity/i)

    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(openManagedFile).not.toHaveBeenCalled()
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('accepts a local source and saves through the same managed pipeline', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/Users/example/logs/proxy.log')
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openManagedFile = vi.fn().mockResolvedValue({ copyTo, close })
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'proxy.log')
    })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile
    })

    const result = await handlers.get('file:save-managed')!(
      { sender: {} },
      {
        source: 'local',
        path: '/Users/example/logs/proxy.log',
        suggestedName: 'proxy.log'
      }
    )

    expect(resolveManagedFilePath).toHaveBeenCalledWith('local', {
      path: '/Users/example/logs/proxy.log'
    })
    expect(copyTo).toHaveBeenCalledWith(join(downloadsPath, 'proxy.log'))
    expect(close).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      saved: true,
      filePath: join(downloadsPath, 'proxy.log')
    })
  })

  it('exports a Notebook input through its trusted lease without resolving a source path', async () => {
    const resolveManagedFilePath = vi
      .fn()
      .mockRejectedValue(new Error('path resolver must not run'))
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openNotebookInput = vi.fn().mockResolvedValue({ copyTo, close })
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'captured.csv')
    })
    registerFileSaveHandlers({ resolveManagedFilePath, openNotebookInput } as never)

    const result = await handlers.get('file:save-managed')!(
      { sender: {} },
      {
        source: 'notebook-input',
        path: 'notebook-input-preview-key',
        suggestedName: 'captured.csv'
      }
    )

    expect(openNotebookInput).toHaveBeenCalledWith({ path: 'notebook-input-preview-key' })
    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(copyTo).toHaveBeenCalledWith(join(downloadsPath, 'captured.csv'))
    expect(close).toHaveBeenCalledOnce()
    expect(result).toEqual({
      saved: true,
      filePath: join(downloadsPath, 'captured.csv')
    })
  })

  it('copies the original pending file identity after it is finalized during Save As', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/.pending/report.csv')
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openManagedFile = vi.fn().mockResolvedValue({ copyTo, close })
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'report.csv')
    })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile
    })

    await handlers.get('file:save-managed')!(
      { sender: {} },
      { source: 'local', path: 'session/report.csv', suggestedName: 'report.csv' }
    )

    expect(resolveManagedFilePath).toHaveBeenCalledTimes(1)
    expect(copyTo).toHaveBeenCalledWith(join(downloadsPath, 'report.csv'))
    expect(openManagedFile).toHaveBeenCalledWith('/managed/.pending/report.csv')
  })

  it('keeps copying the same real file handle when its source path is renamed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-'))
    const pendingPath = join(root, 'pending-report.csv')
    const finalizedPath = join(root, 'final-report.csv')
    const destinationPath = join(root, 'downloaded-report.csv')
    await writeFile(pendingPath, 'stable artifact bytes')
    const resolveManagedFilePath = vi.fn().mockResolvedValue(pendingPath)
    showSaveDialog.mockImplementation(async () => {
      await rename(pendingPath, finalizedPath)
      return { canceled: false, filePath: destinationPath }
    })
    registerFileSaveHandlers({ resolveManagedFilePath })

    try {
      await handlers.get('file:save-managed')!(
        { sender: {} },
        { source: 'local', path: pendingPath, suggestedName: 'report.csv' }
      )

      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('stable artifact bytes')
      await expect(readFile(finalizedPath, 'utf8')).resolves.toBe('stable artifact bytes')
      expect(resolveManagedFilePath).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not truncate a managed file when Save As selects the source itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-source-'))
    const sourcePath = join(root, 'report.csv')
    await writeFile(sourcePath, 'source must survive')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: sourcePath })
    registerFileSaveHandlers({
      resolveManagedFilePath: vi.fn().mockResolvedValue(sourcePath)
    })

    try {
      await expect(
        handlers.get('file:save-managed')!(
          { sender: {} },
          { source: 'local', path: sourcePath, suggestedName: 'report.csv' }
        )
      ).rejects.toThrow('Cannot save a managed file over its source.')
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe('source must survive')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps traversal-only suggested names inside Downloads', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/source-report.csv')
    showSaveDialog.mockResolvedValue({ canceled: true })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile: vi.fn().mockResolvedValue({
        copyTo: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      })
    } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      { source: 'local', path: '/managed/source-report.csv', suggestedName: '..' }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: join(downloadsPath, 'source-report.csv')
      })
    )
  })

  it('rejects malformed requests before resolving or prompting', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/report.csv')
    registerFileSaveHandlers({ resolveManagedFilePath } as never)

    await expect(
      handlers.get('file:save-managed')!(
        { sender: {} },
        {
          source: 'workspace',
          path: '/outside/report.csv',
          suggestedName: 'report.csv'
        }
      )
    ).rejects.toThrow('Invalid managed file save request.')

    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('returns without copying when the save dialog is canceled', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/report.csv')
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openManagedFile = vi.fn().mockResolvedValue({
      copyTo,
      close
    })
    showSaveDialog.mockResolvedValue({ canceled: true })
    registerFileSaveHandlers({ resolveManagedFilePath, openManagedFile } as never)

    const result = await handlers.get('file:save-managed')!(
      { sender: {} },
      { source: 'local', path: '/managed/report.csv', suggestedName: 'report.csv' }
    )

    expect(result).toEqual({ saved: false })
    expect(openManagedFile).toHaveBeenCalledWith('/managed/report.csv')
    expect(copyTo).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the managed file handle when copying fails', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/report.csv')
    const copyTo = vi.fn().mockRejectedValue(new Error('disk full'))
    const close = vi.fn().mockResolvedValue(undefined)
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'report.csv')
    })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile: vi.fn().mockResolvedValue({ copyTo, close })
    } as never)

    await expect(
      handlers.get('file:save-managed')!(
        { sender: {} },
        { source: 'local', path: '/managed/report.csv', suggestedName: 'report.csv' }
      )
    ).rejects.toThrow('disk full')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('preserves an existing managed-file destination when copying fails after a partial write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-failure-'))
    const destinationPath = join(root, 'report.csv')
    await writeFile(destinationPath, 'existing destination')
    const copyTo = vi.fn(async (path: string) => {
      await writeFile(path, 'partial replacement')
      throw new Error('disk full')
    })
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({
      resolveManagedFilePath: vi.fn().mockResolvedValue('/managed/report.csv'),
      publishUserFile: productionPublishUserFile,
      openManagedFile: vi.fn().mockResolvedValue({
        copyTo,
        close: vi.fn().mockResolvedValue(undefined)
      })
    } as never)

    try {
      await expect(
        handlers.get('file:save-managed')!(
          { sender: {} },
          { source: 'local', path: '/managed/report.csv', suggestedName: 'report.csv' }
        )
      ).rejects.toThrow('disk full')
      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('existing destination')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not prompt when managed path validation fails', async () => {
    const resolveManagedFilePath = vi.fn().mockRejectedValue(new Error('outside artifact storage'))
    registerFileSaveHandlers({ resolveManagedFilePath } as never)

    await expect(
      handlers.get('file:save-managed')!(
        { sender: {} },
        { source: 'local', path: '/outside/report.csv', suggestedName: 'report.csv' }
      )
    ).rejects.toThrow('outside artifact storage')

    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('throws when no managed file resolver is configured', async () => {
    registerFileSaveHandlers()

    await expect(
      handlers.get('file:save-managed')!(
        { sender: {} },
        { source: 'local', path: '/managed/report.csv', suggestedName: 'report.csv' }
      )
    ).rejects.toThrow('Managed file resolver is not configured.')

    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('falls back to the source basename when suggestedName is a single dot', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/source-report.csv')
    showSaveDialog.mockResolvedValue({ canceled: true })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile: vi.fn().mockResolvedValue({
        copyTo: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      })
    } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      { source: 'local', path: '/managed/source-report.csv', suggestedName: '.' }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: join(downloadsPath, 'source-report.csv')
      })
    )
  })

  it('falls back to the source basename when suggestedName is whitespace only', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/source-report.csv')
    showSaveDialog.mockResolvedValue({ canceled: true })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile: vi.fn().mockResolvedValue({
        copyTo: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      })
    } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      { source: 'local', path: '/managed/source-report.csv', suggestedName: '   ' }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: join(downloadsPath, 'source-report.csv')
      })
    )
  })

  it('bundles Project Artifacts and Uploads into one zip archive grouped by source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-artifacts-'))
    const artifactPath = join(root, 'managed-report.csv')
    const uploadPath = join(root, 'managed-upload.csv')
    const notesPath = join(root, 'managed-notes.txt')
    await writeFile(artifactPath, 'artifact bytes')
    await writeFile(uploadPath, 'upload bytes')
    await writeFile(notesPath, 'notes bytes')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(artifactPath)
      .mockResolvedValueOnce(notesPath)
    const resolveManagedFilePath = vi.fn().mockResolvedValue(uploadPath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      resolveManagedFilePath,
      resolveSessionArtifactFilePath
    } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'report.csv'
            },
            {
              source: 'upload',
              sessionId: 'session-2',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'report.csv'
            },
            {
              source: 'artifact',
              sessionId: 'session-2',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'notes.txt'
            }
          ]
        }
      )

      expect(showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: join(downloadsPath, 'Research-artifacts.zip'),
          title: 'Download project artifacts'
        })
      )
      expect(result).toEqual({ saved: true, filePath: destinationPath })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Object.keys(entries).sort()).toEqual([
        'generated/notes.txt',
        'generated/report.csv',
        'uploads/report.csv'
      ])
      expect(Buffer.from(entries['generated/report.csv']!).toString('utf8')).toBe('artifact bytes')
      expect(Buffer.from(entries['uploads/report.csv']!).toString('utf8')).toBe('upload bytes')
      expect(Buffer.from(entries['generated/notes.txt']!).toString('utf8')).toBe('notes bytes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('shows Save As before opening Project Versions and holds only one lease at a time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-lease-order-'))
    const destinationPath = join(root, 'Research-artifacts.zip')
    const events: string[] = []
    let activeLeases = 0
    let maximumActiveLeases = 0
    const openManagedFileVersion = vi.fn(
      async (_source: 'artifact' | 'upload', request: { fileId: string }) => {
        events.push(`open:${request.fileId}`)
        activeLeases += 1
        maximumActiveLeases = Math.max(maximumActiveLeases, activeLeases)
        return managedVersionHandle(request.fileId, {
          close: vi.fn(async () => {
            activeLeases -= 1
            events.push(`close:${request.fileId}`)
          })
        })
      }
    )
    showSaveDialog.mockImplementation(async () => {
      events.push('dialog')
      return { canceled: false, filePath: destinationPath }
    })
    registerProjectFileSaveHandlers({ openManagedFileVersion })

    try {
      await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'artifact-1',
              versionId: 'artifact-version-1',
              suggestedName: 'artifact.txt'
            },
            {
              source: 'upload',
              sessionId: 'session-1',
              fileId: 'upload-1',
              versionId: 'upload-version-1',
              suggestedName: 'upload.txt'
            }
          ]
        }
      )

      expect(events).toEqual([
        'dialog',
        'open:artifact-1',
        'close:artifact-1',
        'open:upload-1',
        'close:upload-1'
      ])
      expect(maximumActiveLeases).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads each logical Project file from its selected managed Version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-current-head-'))
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveManagedFilePath = vi.fn().mockRejectedValue(new Error('stale path used'))
    const resolveSessionArtifactFilePath = vi.fn().mockRejectedValue(new Error('stale path used'))
    const closeArtifact = vi.fn().mockResolvedValue(undefined)
    const closeUpload = vi.fn().mockResolvedValue(undefined)
    const verifyArtifact = vi.fn().mockResolvedValue(undefined)
    const verifyUpload = vi.fn().mockResolvedValue(undefined)
    const openLatestManagedFile = vi
      .fn()
      .mockResolvedValueOnce({
        size: 21,
        readRange: vi.fn().mockResolvedValue(Buffer.from('current artifact head')),
        verifyUnchanged: verifyArtifact,
        copyTo: vi.fn(),
        close: closeArtifact
      })
      .mockResolvedValueOnce({
        size: 19,
        readRange: vi.fn().mockResolvedValue(Buffer.from('current upload head')),
        verifyUnchanged: verifyUpload,
        copyTo: vi.fn(),
        close: closeUpload
      })
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      resolveManagedFilePath,
      resolveSessionArtifactFilePath,
      openLatestManagedFile
    } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'artifact-file-1',
              versionId: 'artifact-file-1-version',
              suggestedName: 'report.csv'
            },
            {
              source: 'upload',
              sessionId: 'session-2',
              fileId: 'upload-file-1',
              versionId: 'upload-file-1-version',
              suggestedName: 'data.csv'
            }
          ]
        }
      )

      expect(result).toEqual({ saved: true, filePath: destinationPath })
      expect(openLatestManagedFile.mock.calls).toEqual([
        [
          'artifact',
          {
            projectId: 'project-1',
            fileId: 'artifact-file-1',
            versionId: 'artifact-file-1-version'
          }
        ],
        [
          'upload',
          {
            projectId: 'project-1',
            fileId: 'upload-file-1',
            versionId: 'upload-file-1-version'
          }
        ]
      ])
      expect(resolveManagedFilePath).not.toHaveBeenCalled()
      expect(resolveSessionArtifactFilePath).not.toHaveBeenCalled()
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Buffer.from(entries['generated/report.csv']!).toString('utf8')).toBe(
        'current artifact head'
      )
      expect(Buffer.from(entries['uploads/data.csv']!).toString('utf8')).toBe('current upload head')
      expect(verifyArtifact).toHaveBeenCalledOnce()
      expect(verifyUpload).toHaveBeenCalledOnce()
      expect(closeArtifact).toHaveBeenCalledOnce()
      expect(closeUpload).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not open a Project Version when temporary archive setup fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const readRange = vi.fn()
    const verifyUnchanged = vi.fn()
    const temporaryRootError = new Error('temporary storage unavailable')
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'Research-artifacts.zip')
    })
    const openLatestManagedFile = vi.fn().mockResolvedValue({
      size: 1,
      readRange,
      verifyUnchanged,
      copyTo: vi.fn(),
      close
    })
    registerProjectFileSaveHandlers({
      openLatestManagedFile,
      createProjectArtifactTemporaryRoot: vi.fn().mockRejectedValue(temporaryRootError)
    } as never)

    await expect(
      handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'artifact-file-1',
              versionId: 'artifact-file-1-version',
              suggestedName: 'report.csv'
            }
          ]
        }
      )
    ).rejects.toBe(temporaryRootError)
    expect(readRange).not.toHaveBeenCalled()
    expect(verifyUnchanged).not.toHaveBeenCalled()
    expect(openLatestManagedFile).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('exports Project Artifacts without reading an entire source into memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-stream-'))
    const destinationPath = join(root, 'Research-artifacts.zip')
    const bytes = Buffer.from('artifact bytes')
    const readRange = vi.fn(async (begin: number, end: number) => bytes.subarray(begin, end))
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      openLatestManagedFile: vi.fn().mockResolvedValue(managedVersionHandle(bytes, { readRange }))
    })

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'report.csv'
            }
          ]
        }
      )

      expect(zipSyncMock).not.toHaveBeenCalled()
      expect(readRange).toHaveBeenCalledWith(0, bytes.byteLength)
      expect(result).toEqual({ saved: true, filePath: destinationPath })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Buffer.from(entries['generated/report.csv']!).toString('utf8')).toBe('artifact bytes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a Project Artifact whose latest Version lease changes while archiving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-identity-'))
    const destinationPath = join(root, 'Research-artifacts.zip')
    await writeFile(destinationPath, 'existing destination')
    const close = vi.fn().mockResolvedValue(undefined)
    const verifyUnchanged = vi.fn().mockRejectedValue(new Error('Version lease changed.'))
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      openLatestManagedFile: vi
        .fn()
        .mockResolvedValue(managedVersionHandle('artifact bytes', { close, verifyUnchanged }))
    })

    try {
      await expect(
        handlers.get('file:save-project-artifacts')!(
          { sender: {} },
          {
            projectId: 'project-1',
            suggestedArchiveName: 'Research',
            files: [
              {
                source: 'artifact',
                sessionId: 'session-1',
                fileId: 'test-file-id',
                versionId: 'test-file-id-version',
                suggestedName: 'report.csv'
              }
            ]
          }
        )
      ).rejects.toThrow('Version lease changed.')
      expect(verifyUnchanged).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('existing destination')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not bypass a managed Version lease failure through a legacy path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-native-fallback-'))
    const sourcePath = join(root, 'managed-report.csv')
    const destinationPath = join(root, 'Research-artifacts.zip')
    await writeFile(sourcePath, 'legacy fallback bytes')
    const resolveManagedFilePath = vi.fn().mockResolvedValue({
      fileId: 'test-file-id',
      expectedSize: Buffer.byteLength('legacy fallback bytes'),
      expectedChecksum: sha256('legacy fallback bytes')
    })
    const resolveSessionArtifactFilePath = vi.fn()
    const openLatestManagedFile = vi.fn().mockRejectedValue(
      Object.assign(new Error('Managed version storage is unavailable.'), {
        code: 'STORAGE_UNAVAILABLE'
      })
    )
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      resolveManagedFilePath,
      resolveSessionArtifactFilePath,
      openLatestManagedFile
    } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'artifact-file-1',
              versionId: 'artifact-file-1-version',
              suggestedName: 'report.csv'
            }
          ]
        }
      )

      expect(result).toEqual({
        saved: true,
        failures: [
          {
            source: 'artifact',
            sessionId: 'session-1',
            fileId: 'artifact-file-1',
            versionId: 'artifact-file-1-version',
            suggestedName: 'report.csv',
            message: 'Managed version storage is unavailable.'
          }
        ]
      })
      expect(resolveManagedFilePath).not.toHaveBeenCalled()
      expect(resolveSessionArtifactFilePath).not.toHaveBeenCalled()
      expect(showSaveDialog).toHaveBeenCalledOnce()
      await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not hide managed Version integrity failures behind the legacy path fallback', async () => {
    const resolveSessionArtifactFilePath = vi.fn().mockResolvedValue('/managed/legacy-report.csv')
    const openLatestManagedFile = vi.fn().mockRejectedValue(
      Object.assign(new Error('Managed file version content is unavailable or corrupt.'), {
        code: 'CONTENT_INTEGRITY_FAILED'
      })
    )
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'Research-artifacts.zip')
    })
    registerProjectFileSaveHandlers({
      resolveSessionArtifactFilePath,
      openLatestManagedFile
    } as never)

    const result = await handlers.get('file:save-project-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        suggestedArchiveName: 'Research',
        files: [
          {
            source: 'artifact',
            sessionId: 'session-1',
            fileId: 'artifact-file-1',
            versionId: 'artifact-file-1-version',
            suggestedName: 'report.csv'
          }
        ]
      }
    )

    expect(result).toEqual({
      saved: true,
      failures: [
        {
          source: 'artifact',
          sessionId: 'session-1',
          fileId: 'artifact-file-1',
          versionId: 'artifact-file-1-version',
          suggestedName: 'report.csv',
          message: 'Managed file version content is unavailable or corrupt.'
        }
      ]
    })
    expect(resolveSessionArtifactFilePath).not.toHaveBeenCalled()
    expect(showSaveDialog).toHaveBeenCalledOnce()
  })

  it('opens the immutable Project file Version selected in the renderer snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-version-'))
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi.fn()
    const openLatestManagedFile = vi.fn()
    const openManagedFileVersion = vi
      .fn()
      .mockResolvedValue(managedVersionHandle('selected artifact version'))
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      resolveSessionArtifactFilePath,
      openLatestManagedFile,
      openManagedFileVersion
    } as never)

    try {
      await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'artifact-file-1',
              versionId: 'artifact-version-1',
              suggestedName: 'report.csv'
            }
          ]
        }
      )
      expect(openManagedFileVersion).toHaveBeenCalledWith('artifact', {
        projectId: 'project-1',
        fileId: 'artifact-file-1',
        versionId: 'artifact-version-1'
      })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Buffer.from(entries['generated/report.csv']!).toString('utf8')).toBe(
        'selected artifact version'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    expect(openLatestManagedFile).not.toHaveBeenCalled()
    expect(resolveSessionArtifactFilePath).not.toHaveBeenCalled()
  })

  it('applies collision suffixes within each source category only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-categories-'))
    const artifactPathA = join(root, 'managed-a.csv')
    const artifactPathB = join(root, 'managed-b.csv')
    const uploadPath = join(root, 'managed-upload.csv')
    await writeFile(artifactPathA, 'artifact a')
    await writeFile(artifactPathB, 'artifact b')
    await writeFile(uploadPath, 'upload bytes')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(artifactPathA)
      .mockResolvedValueOnce(artifactPathB)
    const resolveManagedFilePath = vi.fn().mockResolvedValue(uploadPath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      resolveManagedFilePath,
      resolveSessionArtifactFilePath
    } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'report.csv'
            },
            {
              source: 'upload',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'report.csv'
            },
            {
              source: 'artifact',
              sessionId: 'session-2',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'report.csv'
            }
          ]
        }
      )

      expect(result).toEqual({ saved: true, filePath: destinationPath })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Object.keys(entries).sort()).toEqual([
        'generated/report (2).csv',
        'generated/report.csv',
        'uploads/report.csv'
      ])
      expect(Buffer.from(entries['generated/report.csv']!).toString('utf8')).toBe('artifact a')
      expect(Buffer.from(entries['generated/report (2).csv']!).toString('utf8')).toBe('artifact b')
      expect(Buffer.from(entries['uploads/report.csv']!).toString('utf8')).toBe('upload bytes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports per-file failures and still archives the resolvable entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-partial-'))
    const artifactPath = join(root, 'managed-report.csv')
    await writeFile(artifactPath, 'artifact bytes')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(artifactPath)
      .mockRejectedValueOnce(new Error('Artifact bytes are unavailable.'))
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'report.csv'
            },
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'gone.csv'
            }
          ]
        }
      )

      expect(result).toEqual({
        saved: true,
        filePath: destinationPath,
        failures: [
          {
            source: 'artifact',
            sessionId: 'session-1',
            fileId: 'test-file-id',
            versionId: 'test-file-id-version',
            suggestedName: 'gone.csv',
            message: 'Artifact bytes are unavailable.'
          }
        ]
      })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Object.keys(entries)).toEqual(['generated/report.csv'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns saved false when the Project Artifact Save As dialog is canceled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-cancel-'))
    const artifactPath = join(root, 'managed-report.csv')
    await writeFile(artifactPath, 'artifact bytes')
    const resolveSessionArtifactFilePath = vi.fn().mockResolvedValue(artifactPath)
    showSaveDialog.mockResolvedValue({ canceled: true })
    registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'report.csv'
            }
          ]
        }
      )

      expect(result).toEqual({ saved: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes no archive when no Project Artifact resolves after Save As', async () => {
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockRejectedValue(new Error('Artifact bytes are unavailable.'))
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'Research-artifacts.zip')
    })
    registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    const result = await handlers.get('file:save-project-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        suggestedArchiveName: 'Research',
        files: [
          {
            source: 'artifact',
            sessionId: 'session-1',
            fileId: 'test-file-id',
            versionId: 'test-file-id-version',
            suggestedName: 'gone.csv'
          }
        ]
      }
    )

    expect(showSaveDialog).toHaveBeenCalledOnce()
    expect(result).toEqual({
      saved: true,
      failures: [
        {
          source: 'artifact',
          sessionId: 'session-1',
          fileId: 'test-file-id',
          versionId: 'test-file-id-version',
          suggestedName: 'gone.csv',
          message: 'Artifact bytes are unavailable.'
        }
      ]
    })
  })

  it('skips files over the per-file export limit and still archives the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-oversized-'))
    const smallPath = join(root, 'managed-small.txt')
    const bigPath = join(root, 'managed-big.txt')
    await writeFile(smallPath, 'small')
    await writeFile(bigPath, 'this upload is far too large')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi.fn().mockResolvedValue(smallPath)
    const resolveManagedFilePath = vi.fn().mockResolvedValue(bigPath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      resolveManagedFilePath,
      resolveSessionArtifactFilePath,
      projectArtifactExportLimits: { maxFiles: 5000, maxFileBytes: 10, maxTotalBytes: 1024 }
    } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'small.txt'
            },
            {
              source: 'upload',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'big.txt'
            }
          ]
        }
      )

      expect(result).toEqual({
        saved: true,
        filePath: destinationPath,
        failures: [
          {
            source: 'upload',
            sessionId: 'session-1',
            fileId: 'test-file-id',
            versionId: 'test-file-id-version',
            suggestedName: 'big.txt',
            message: 'Project export file exceeds the per-file size limit.'
          }
        ]
      })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Object.keys(entries)).toEqual(['generated/small.txt'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops archiving once the total export size limit is reached', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-total-'))
    const firstPath = join(root, 'managed-first.txt')
    const secondPath = join(root, 'managed-second.txt')
    await writeFile(firstPath, '12345678')
    await writeFile(secondPath, '87654321')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(firstPath)
      .mockResolvedValueOnce(secondPath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      resolveSessionArtifactFilePath,
      projectArtifactExportLimits: { maxFiles: 5000, maxFileBytes: 100, maxTotalBytes: 12 }
    } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'first.txt'
            },
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'second.txt'
            }
          ]
        }
      )

      expect(result).toEqual({
        saved: true,
        filePath: destinationPath,
        failures: [
          {
            source: 'artifact',
            sessionId: 'session-1',
            fileId: 'test-file-id',
            versionId: 'test-file-id-version',
            suggestedName: 'second.txt',
            message: 'Project export exceeds the total size limit.'
          }
        ]
      })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Object.keys(entries)).toEqual(['generated/first.txt'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports files beyond the export file-count limit without archiving them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-count-'))
    const firstPath = join(root, 'managed-first.txt')
    const secondPath = join(root, 'managed-second.txt')
    await writeFile(firstPath, 'first')
    await writeFile(secondPath, 'second')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(firstPath)
      .mockResolvedValueOnce(secondPath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      resolveSessionArtifactFilePath,
      projectArtifactExportLimits: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 }
    } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'first.txt'
            },
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'second.txt'
            }
          ]
        }
      )

      expect(result).toEqual({
        saved: true,
        filePath: destinationPath,
        failures: [
          {
            source: 'artifact',
            sessionId: 'session-1',
            fileId: 'test-file-id',
            versionId: 'test-file-id-version',
            suggestedName: 'second.txt',
            message: 'Project export exceeds the file-count limit.'
          }
        ]
      })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Object.keys(entries)).toEqual(['generated/first.txt'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('strips Windows path separators and directory segments from zip entry names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-slip-'))
    const evilPath = join(root, 'managed-evil.exe')
    const notesPath = join(root, 'managed-notes.txt')
    await writeFile(evilPath, 'evil bytes')
    await writeFile(notesPath, 'notes bytes')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(evilPath)
      .mockResolvedValueOnce(notesPath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: '..\\..\\evil.exe'
            },
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'nested/dir/notes.txt'
            }
          ]
        }
      )

      expect(result).toEqual({ saved: true, filePath: destinationPath })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Object.keys(entries).sort()).toEqual(['generated/evil.exe', 'generated/notes.txt'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed Project Artifact save requests before resolving', async () => {
    registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath: vi.fn() } as never)

    await expect(
      handlers.get('file:save-project-artifacts')!({ sender: {} }, null)
    ).rejects.toThrow('Invalid Project Artifact save request.')
    await expect(
      handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        { projectId: 'project-1', suggestedArchiveName: 'Research', files: [] }
      )
    ).rejects.toThrow('Invalid Project Artifact save request.')

    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('archives a file whose suggestedName is __proto__ under a safe entry name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-proto-'))
    const sourcePath = join(root, 'managed-proto.txt')
    await writeFile(sourcePath, 'proto bytes')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi.fn().mockResolvedValue(sourcePath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: '__proto__'
            }
          ]
        }
      )

      expect(result).toEqual({ saved: true, filePath: destinationPath })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      // fflate cannot store an entry literally named __proto__; use a neutral logical fallback,
      // never the locator or internal immutable Version filename.
      expect(Object.keys(entries)).toEqual(['generated/file'])
      expect(Buffer.from(entries['generated/file']!).toString('utf8')).toBe('proto bytes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts the export when a latest Version lease returns bytes outside the requested range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-growth-'))
    const destinationPath = join(root, 'Research-artifacts.zip')
    await writeFile(destinationPath, 'existing destination')
    const close = vi.fn().mockResolvedValue(undefined)
    const readRange = vi.fn().mockResolvedValue(Buffer.from('this exceeds the requested range'))
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      openLatestManagedFile: vi
        .fn()
        .mockResolvedValue(managedVersionHandle('12345', { close, readRange })),
      projectArtifactExportLimits: { maxFiles: 5000, maxFileBytes: 10, maxTotalBytes: 1024 }
    })

    try {
      await expect(
        handlers.get('file:save-project-artifacts')!(
          { sender: {} },
          {
            projectId: 'project-1',
            suggestedArchiveName: 'Research',
            files: [
              {
                source: 'artifact',
                sessionId: 'session-1',
                fileId: 'test-file-id',
                versionId: 'test-file-id-version',
                suggestedName: 'report.csv'
              }
            ]
          }
        )
      ).rejects.toThrow('Project export source changed while streaming.')

      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('existing destination')
      expect(showSaveDialog).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports invalid latest Version sizes without reading them', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const readRange = vi.fn()
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'Research-artifacts.zip')
    })
    registerProjectFileSaveHandlers({
      openLatestManagedFile: vi
        .fn()
        .mockResolvedValue(managedVersionHandle('', { size: Number.NaN, readRange, close }))
    })

    const result = await handlers.get('file:save-project-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        suggestedArchiveName: 'Research',
        files: [
          {
            source: 'artifact',
            sessionId: 'session-1',
            fileId: 'test-file-id',
            versionId: 'test-file-id-version',
            suggestedName: 'fifo.csv'
          }
        ]
      }
    )

    expect(result).toEqual({
      saved: true,
      failures: [
        {
          source: 'artifact',
          sessionId: 'session-1',
          fileId: 'test-file-id',
          versionId: 'test-file-id-version',
          suggestedName: 'fifo.csv',
          message: 'Project export source size is invalid.'
        }
      ]
    })
    expect(readRange).not.toHaveBeenCalled()
    expect(showSaveDialog).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('rejects Project Artifact save requests with an unbounded file list', async () => {
    const resolveSessionArtifactFilePath = vi.fn()
    registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath } as never)
    const files = Array.from({ length: 10001 }, (_, index) => ({
      source: 'artifact',
      sessionId: 'session-1',
      fileId: 'test-file-id',
      versionId: 'test-file-id-version',
      suggestedName: `${index}.txt`
    }))

    await expect(
      handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        { projectId: 'project-1', suggestedArchiveName: 'Research', files }
      )
    ).rejects.toThrow('Invalid Project Artifact save request.')
    expect(resolveSessionArtifactFilePath).not.toHaveBeenCalled()
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it.each([
    ['Q3: analysis', 'Q3- analysis-artifacts.zip'],
    ['report\t2024', 'report-2024-artifacts.zip'],
    ['a/b\\c:d', 'a-b-c-d-artifacts.zip'],
    ['..', 'project-artifacts.zip'],
    ['   ', 'project-artifacts.zip'],
    ['Research', 'Research-artifacts.zip']
  ])(
    'sanitizes the suggested archive name %p for the zip default path',
    async (suggestedArchiveName, expectedFileName) => {
      const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-name-'))
      const sourcePath = join(root, 'managed-report.csv')
      await writeFile(sourcePath, 'artifact bytes')
      const resolveSessionArtifactFilePath = vi.fn().mockResolvedValue(sourcePath)
      showSaveDialog.mockResolvedValue({ canceled: true })
      registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

      try {
        await handlers.get('file:save-project-artifacts')!(
          { sender: {} },
          {
            projectId: 'project-1',
            suggestedArchiveName,
            files: [
              {
                source: 'artifact',
                sessionId: 'session-1',
                fileId: 'test-file-id',
                versionId: 'test-file-id-version',
                suggestedName: 'report.csv'
              }
            ]
          }
        )

        expect(showSaveDialog).toHaveBeenCalledWith(
          expect.objectContaining({ defaultPath: join(downloadsPath, expectedFileName) })
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('claims zip entry names case-insensitively so case-only twins cannot overlap on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-case-'))
    const upperPath = join(root, 'managed-upper.csv')
    const lowerPath = join(root, 'managed-lower.csv')
    await writeFile(upperPath, 'upper bytes')
    await writeFile(lowerPath, 'lower bytes')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(upperPath)
      .mockResolvedValueOnce(lowerPath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'A.csv'
            },
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'a.csv'
            }
          ]
        }
      )

      expect(result).toEqual({ saved: true, filePath: destinationPath })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Object.keys(entries).sort()).toEqual(['generated/A.csv', 'generated/a (2).csv'])
      expect(Buffer.from(entries['generated/A.csv']!).toString('utf8')).toBe('upper bytes')
      expect(Buffer.from(entries['generated/a (2).csv']!).toString('utf8')).toBe('lower bytes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replaces Windows-illegal characters in zip entry file names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-illegal-'))
    const sourcePath = join(root, 'managed-report.csv')
    await writeFile(sourcePath, 'artifact bytes')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi.fn().mockResolvedValue(sourcePath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'a<b>.csv'
            }
          ]
        }
      )

      expect(result).toEqual({ saved: true, filePath: destinationPath })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Object.keys(entries)).toEqual(['generated/a-b-.csv'])
      expect(Buffer.from(entries['generated/a-b-.csv']!).toString('utf8')).toBe('artifact bytes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts a file whose size equals the per-file and total export limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-exact-'))
    const sourcePath = join(root, 'managed-exact.bin')
    await writeFile(sourcePath, '0123456789')
    const destinationPath = join(root, 'Research-artifacts.zip')
    const resolveSessionArtifactFilePath = vi.fn().mockResolvedValue(sourcePath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerProjectFileSaveHandlers({
      resolveSessionArtifactFilePath,
      projectArtifactExportLimits: { maxFiles: 5000, maxFileBytes: 10, maxTotalBytes: 10 }
    } as never)

    try {
      const result = await handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [
            {
              source: 'artifact',
              sessionId: 'session-1',
              fileId: 'test-file-id',
              versionId: 'test-file-id-version',
              suggestedName: 'exact.bin'
            }
          ]
        }
      )

      expect(result).toEqual({ saved: true, filePath: destinationPath })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Object.keys(entries)).toEqual(['generated/exact.bin'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects Project Artifact save requests with invalid per-file fields', async () => {
    const resolveSessionArtifactFilePath = vi.fn()
    registerProjectFileSaveHandlers({ resolveSessionArtifactFilePath } as never)
    const baseFile = {
      source: 'artifact',
      sessionId: 'session-1',
      fileId: 'artifact-file-1',
      versionId: 'artifact-file-1-version',
      suggestedName: 'report.csv'
    }

    await expect(
      handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [{ ...baseFile, source: 'notebook-input' }]
        }
      )
    ).rejects.toThrow('Invalid Project Artifact save request.')
    await expect(
      handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [{ ...baseFile, sessionId: '' }]
        }
      )
    ).rejects.toThrow('Invalid Project Artifact save request.')
    await expect(
      handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [{ ...baseFile, fileId: undefined }]
        }
      )
    ).rejects.toThrow('Invalid Project Artifact save request.')
    await expect(
      handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [{ ...baseFile, versionId: undefined }]
        }
      )
    ).rejects.toThrow('Invalid Project Artifact save request.')
    await expect(
      handlers.get('file:save-project-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          suggestedArchiveName: 'Research',
          files: [{ ...baseFile, path: '/legacy/path.csv' }]
        }
      )
    ).rejects.toThrow('Invalid Project Artifact save request.')

    expect(resolveSessionArtifactFilePath).not.toHaveBeenCalled()
    expect(showSaveDialog).not.toHaveBeenCalled()
  })
})

describe('file save blob handler', () => {
  beforeEach(() => {
    handlers.clear()
    showSaveDialog.mockReset()
    registerFileSaveHandlers()
  })

  it('registers the file:save-blob channel', () => {
    expect(handlers.has('file:save-blob')).toBe(true)
  })

  it('returns {saved:false} when the dialog is canceled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })

    const result = await handlers.get('file:save-blob')!(
      { sender: {} },
      {
        suggestedName: 'image.png',
        mimeType: 'image/png',
        data: new ArrayBuffer(0)
      }
    )

    expect(result).toEqual({ saved: false })
  })

  it('writes the blob bytes to the chosen destination and returns the path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-blob-'))
    const destination = join(root, 'export.png')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })

    try {
      const result = await handlers.get('file:save-blob')!(
        { sender: {} },
        {
          suggestedName: 'image.png',
          mimeType: 'image/png',
          data: new TextEncoder().encode('hello-blob').buffer
        }
      )

      expect(result).toEqual({ saved: true, filePath: destination })
      expect(showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: 'image.png',
          filters: [{ name: 'PNG', extensions: ['png'] }]
        })
      )
      await expect(readFile(destination, 'utf8')).resolves.toBe('hello-blob')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps image/svg+xml to the svg extension filter', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'icon.svg', mimeType: 'image/svg+xml', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'SVG', extensions: ['svg'] }]
      })
    )
  })

  it.each([
    ['text/x-python', 'script.py', 'PY', 'py'],
    ['text/x-r', 'script.R', 'R', 'R'],
    ['text/x-sh', 'script.sh', 'SH', 'sh'],
    ['text/plain', 'notes.txt', 'TXT', 'txt']
  ])('maps %s to the %s extension filter', async (mimeType, suggestedName, name, extension) => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName, mimeType, data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name, extensions: [extension] }] })
    )
  })

  it('maps text/csv to the csv extension filter', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'data.csv', mimeType: 'text/csv', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
    )
  })

  it('maps text/tab-separated-values to the tsv extension filter', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'data.tsv', mimeType: 'text/tab-separated-values', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'TSV', extensions: ['tsv'] }]
      })
    )
  })

  it('maps text/markdown to the md extension filter', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'README.md', mimeType: 'text/markdown', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'MD', extensions: ['md'] }]
      })
    )
  })

  it('omits the file-type filter for unrecognised mime types', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'data.bin', mimeType: 'application/octet-stream', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ filters: undefined }))
  })
})

describe('assertSaveManagedFileRequest validation paths', () => {
  beforeEach(() => {
    handlers.clear()
    showSaveDialog.mockReset()
  })

  const reject = async (request: unknown, label: string): Promise<void> => {
    registerFileSaveHandlers({
      resolveManagedFilePath: vi.fn().mockResolvedValue('/managed/report.csv'),
      openManagedFile: vi.fn().mockResolvedValue({
        copyTo: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      })
    } as never)

    await expect(handlers.get('file:save-managed')!({ sender: {} }, request)).rejects.toThrow(
      'Invalid managed file save request.'
    )

    expect(showSaveDialog).not.toHaveBeenCalled()
    // Helps narrow the failure source when a test unexpectedly passes.
    expect(label.length).toBeGreaterThan(0)
  }

  it('rejects a non-object request (e.g. a string)', async () => {
    await reject('not an object', 'string-request')
  })

  it('rejects a null request', async () => {
    await reject(null, 'null-request')
  })

  it('rejects an unsupported source enum value', async () => {
    await reject(
      { source: 'workspace', path: '/managed/report.csv', suggestedName: 'report.csv' },
      'bad-source'
    )
  })

  it('rejects a missing path', async () => {
    await reject({ source: 'local', suggestedName: 'report.csv' }, 'missing-path')
  })

  it('rejects a non-string path', async () => {
    await reject({ source: 'local', path: 42, suggestedName: 'report.csv' }, 'numeric-path')
  })

  it('rejects an empty path', async () => {
    await reject({ source: 'local', path: '', suggestedName: 'report.csv' }, 'empty-path')
  })

  it('rejects a whitespace-only path', async () => {
    await reject({ source: 'local', path: '   ', suggestedName: 'report.csv' }, 'whitespace-path')
  })

  it('rejects a missing suggestedName', async () => {
    await reject({ source: 'local', path: '/managed/report.csv' }, 'missing-suggested-name')
  })

  it('rejects a non-string suggestedName', async () => {
    await reject(
      { source: 'local', path: '/managed/report.csv', suggestedName: 7 },
      'numeric-suggested-name'
    )
  })
})

describe('assertSaveSessionArtifactsRequest logical identity validation', () => {
  beforeEach(() => {
    handlers.clear()
    showSaveDialog.mockReset()
    showOpenDialog.mockReset()
  })

  it.each([
    { identity: {}, label: 'missing file id' },
    { identity: { fileId: 42 }, label: 'numeric file id' },
    { identity: { fileId: '   ' }, label: 'blank file id' },
    { identity: { fileId: 'artifact-1' }, label: 'missing version id' },
    { identity: { fileId: 'artifact-1', versionId: 42 }, label: 'numeric version id' },
    { identity: { fileId: 'artifact-1', versionId: '' }, label: 'blank version id' },
    { identity: { versionId: 'artifact-v1' }, label: 'version without file id' }
  ] as const)('rejects $label before opening a save dialog', async ({ identity }) => {
    registerFileSaveHandlers({ openLatestManagedFile: vi.fn() } as never)

    await expect(
      handlers.get('file:save-session-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          files: [{ path: 'artifact://report', suggestedName: 'report.csv', ...identity }]
        }
      )
    ).rejects.toThrow('Invalid Session Artifact save request.')
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(showOpenDialog).not.toHaveBeenCalled()
  })
})
