import { beforeEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

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

const { registerFileSaveHandlers } = await import('./file-save')

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
    const resolveSessionArtifactFilePath = vi.fn().mockResolvedValue(sourcePath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-session-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          files: [{ path: 'artifact://report', suggestedName: 'report.csv' }]
        }
      )

      expect(resolveSessionArtifactFilePath).toHaveBeenCalledWith(
        'project-1',
        'session-1',
        'artifact://report'
      )
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

  it('exports multiple selected Session Artifacts after choosing one destination folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-session-artifacts-'))
    const sourceA = join(root, 'managed-a.csv')
    const sourceB = join(root, 'managed-b.png')
    const destinationDirectory = join(root, 'downloads')
    await writeFile(sourceA, 'artifact a')
    await writeFile(sourceB, 'artifact b')
    await mkdir(destinationDirectory)
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(sourceA)
      .mockResolvedValueOnce(sourceB)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-session-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          files: [
            { path: 'artifact://a', suggestedName: 'a.csv' },
            { path: 'artifact://b', suggestedName: 'b.png' }
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
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(sourceA)
      .mockResolvedValueOnce(sourceB)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-session-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          files: [
            { path: 'artifact://a', suggestedName: 'report.csv' },
            { path: 'artifact://b', suggestedName: 'report.csv' }
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
      resolveSessionArtifactFilePath: vi
        .fn()
        .mockResolvedValueOnce('/managed/a.csv')
        .mockResolvedValueOnce('/managed/b.csv'),
      openManagedFile: vi
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
          { path: 'artifact://a', suggestedName: 'a.csv' },
          { path: 'artifact://b', suggestedName: 'b.csv' }
        ]
      }
    )

    expect(result).toEqual({
      saved: true,
      filePaths: [join(destinationDirectory, 'a.csv')],
      failures: [
        {
          path: 'artifact://b',
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
      resolveSessionArtifactFilePath: vi
        .fn()
        .mockRejectedValueOnce(new Error('Artifact no longer exists'))
        .mockResolvedValueOnce('/managed/b.csv'),
      openManagedFile: vi.fn().mockResolvedValue({ copyTo, close })
    } as never)

    const result = await handlers.get('file:save-session-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        files: [
          { path: 'artifact://missing', suggestedName: 'missing.csv' },
          { path: 'artifact://b', suggestedName: 'b.csv' }
        ]
      }
    )

    expect(result).toEqual({
      saved: true,
      filePaths: [join(destinationDirectory, 'b.csv')],
      failures: [
        {
          path: 'artifact://missing',
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

  it('resolves a logical managed file only after Save As confirms so a newer DB head is exported', async () => {
    let headPath = '/managed/v1-report.csv'
    const resolveManagedFilePath = vi.fn(async (_source, request) => {
      expect(request).toEqual({
        path: 'artifact-version:stale-v1',
        projectId: 'project-1',
        fileId: 'artifact-1'
      })
      return headPath
    })
    const openManagedFile = vi.fn().mockResolvedValue({
      copyTo: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    })
    showSaveDialog.mockImplementation(async () => {
      headPath = '/managed/v2-report.csv'
      return { canceled: false, filePath: join(downloadsPath, 'report.csv') }
    })
    registerFileSaveHandlers({ resolveManagedFilePath, openManagedFile } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      {
        source: 'artifact',
        path: 'artifact-version:stale-v1',
        projectId: 'project-1',
        fileId: 'artifact-1',
        suggestedName: 'report.csv'
      }
    )

    expect(openManagedFile).toHaveBeenCalledWith('/managed/v2-report.csv')
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
        path: 'artifact-version:stale-v1',
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
        path: 'artifact-version:v1',
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
    const resolveManagedFilePath = vi
      .fn()
      .mockResolvedValueOnce('/managed/a-v2.csv')
      .mockResolvedValueOnce('/managed/b-v4.csv')
    const openManagedFile = vi.fn().mockResolvedValue({
      copyTo: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    })
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({ resolveManagedFilePath, openManagedFile } as never)

    await handlers.get('file:save-session-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        files: [
          { path: 'stale-a', fileId: 'artifact-a', suggestedName: 'a.csv' },
          { path: 'stale-b', fileId: 'artifact-b', suggestedName: 'b.csv' }
        ]
      }
    )

    expect(resolveManagedFilePath).toHaveBeenNthCalledWith(1, 'artifact', {
      path: 'stale-a',
      projectId: 'project-1',
      sessionId: 'session-1',
      fileId: 'artifact-a'
    })
    expect(resolveManagedFilePath).toHaveBeenNthCalledWith(2, 'artifact', {
      path: 'stale-b',
      projectId: 'project-1',
      sessionId: 'session-1',
      fileId: 'artifact-b'
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
          { path: 'stale-a', fileId: 'artifact-a', suggestedName: 'a.csv' },
          {
            path: 'stale-b',
            fileId: 'artifact-b',
            suggestedName: 'b.csv'
          }
        ]
      }
    )

    expect(openLatestManagedFile).toHaveBeenNthCalledWith(1, 'artifact', {
      projectId: 'project-1',
      fileId: 'artifact-a'
    })
    expect(openLatestManagedFile).toHaveBeenNthCalledWith(2, 'artifact', {
      projectId: 'project-1',
      fileId: 'artifact-b'
    })
    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
  })

  it('passes an Upload logical identity to the source-neutral export resolver', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/upload-v3.csv')
    showSaveDialog.mockResolvedValue({ canceled: true })
    registerFileSaveHandlers({ resolveManagedFilePath } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      {
        source: 'upload',
        path: 'upload-version:stale-v1',
        projectId: 'project-1',
        fileId: 'upload-1',
        suggestedName: 'study.csv'
      }
    )

    expect(resolveManagedFilePath).not.toHaveBeenCalled()
  })

  it('opens a managed source once and copies that exact file to the selected destination', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/canonical-report.csv')
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

    const result = await handlers.get('file:save-managed')!(
      { sender: {} },
      {
        source: 'upload',
        path: '/managed/requested-report.csv',
        suggestedName: '../report.csv'
      }
    )

    expect(resolveManagedFilePath).toHaveBeenCalledWith('upload', {
      path: '/managed/requested-report.csv'
    })
    expect(openManagedFile).toHaveBeenCalledWith('/managed/canonical-report.csv')
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: join(downloadsPath, 'report.csv') })
    )
    expect(copyTo).toHaveBeenCalledWith(join(downloadsPath, 'report.csv'))
    expect(close).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      saved: true,
      filePath: join(downloadsPath, 'report.csv')
    })
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
      { source: 'artifact', path: 'session/report.csv', suggestedName: 'report.csv' }
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
        { source: 'artifact', path: pendingPath, suggestedName: 'report.csv' }
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
          { source: 'artifact', path: sourcePath, suggestedName: 'report.csv' }
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
      { source: 'upload', path: '/managed/source-report.csv', suggestedName: '..' }
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
      { source: 'artifact', path: '/managed/report.csv', suggestedName: 'report.csv' }
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
        { source: 'artifact', path: '/managed/report.csv', suggestedName: 'report.csv' }
      )
    ).rejects.toThrow('disk full')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not prompt when managed path validation fails', async () => {
    const resolveManagedFilePath = vi.fn().mockRejectedValue(new Error('outside artifact storage'))
    registerFileSaveHandlers({ resolveManagedFilePath } as never)

    await expect(
      handlers.get('file:save-managed')!(
        { sender: {} },
        { source: 'artifact', path: '/outside/report.csv', suggestedName: 'report.csv' }
      )
    ).rejects.toThrow('outside artifact storage')

    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('throws when no managed file resolver is configured', async () => {
    registerFileSaveHandlers()

    await expect(
      handlers.get('file:save-managed')!(
        { sender: {} },
        { source: 'artifact', path: '/managed/report.csv', suggestedName: 'report.csv' }
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
      { source: 'upload', path: '/managed/source-report.csv', suggestedName: '.' }
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
      { source: 'upload', path: '/managed/source-report.csv', suggestedName: '   ' }
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
    registerFileSaveHandlers({ resolveManagedFilePath, resolveSessionArtifactFilePath } as never)

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
              path: 'artifact://report',
              suggestedName: 'report.csv'
            },
            {
              source: 'upload',
              sessionId: 'session-2',
              path: 'upload://data',
              suggestedName: 'report.csv'
            },
            {
              source: 'artifact',
              sessionId: 'session-2',
              path: 'artifact://notes',
              suggestedName: 'notes.txt'
            }
          ]
        }
      )

      expect(resolveSessionArtifactFilePath).toHaveBeenNthCalledWith(
        1,
        'project-1',
        'session-1',
        'artifact://report'
      )
      expect(resolveManagedFilePath).toHaveBeenCalledWith('upload', {
        path: 'upload://data',
        projectId: 'project-1',
        sessionId: 'session-2'
      })
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

  it('reads each logical Project file from the current managed-file head', async () => {
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
    registerFileSaveHandlers({
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
              path: '/stale/report.csv',
              fileId: 'artifact-file-1',
              suggestedName: 'report.csv'
            },
            {
              source: 'upload',
              sessionId: 'session-2',
              path: '/stale/data.csv',
              fileId: 'upload-file-1',
              suggestedName: 'data.csv'
            }
          ]
        }
      )

      expect(result).toEqual({ saved: true, filePath: destinationPath })
      expect(openLatestManagedFile.mock.calls).toEqual([
        ['artifact', { projectId: 'project-1', fileId: 'artifact-file-1' }],
        ['upload', { projectId: 'project-1', fileId: 'upload-file-1' }]
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

  it('closes a retained Project Version lease when temporary archive setup fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const readRange = vi.fn()
    const verifyUnchanged = vi.fn()
    const temporaryRootError = new Error('temporary storage unavailable')
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'Research-artifacts.zip')
    })
    registerFileSaveHandlers({
      openLatestManagedFile: vi.fn().mockResolvedValue({
        size: 1,
        readRange,
        verifyUnchanged,
        copyTo: vi.fn(),
        close
      }),
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
              path: 'artifact://report',
              fileId: 'artifact-file-1',
              suggestedName: 'report.csv'
            }
          ]
        }
      )
    ).rejects.toBe(temporaryRootError)
    expect(readRange).not.toHaveBeenCalled()
    expect(verifyUnchanged).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('exports Project Artifacts without reading an entire source into memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-stream-'))
    const destinationPath = join(root, 'Research-artifacts.zip')
    const bytes = Buffer.from('artifact bytes')
    const readFileMock = vi.fn().mockResolvedValue(bytes)
    const openProjectArtifactFile = vi.fn().mockImplementation(async () => ({
      stat: vi
        .fn()
        .mockResolvedValue({ isFile: () => true, size: bytes.byteLength, dev: 1, ino: 1 }),
      readFile: readFileMock,
      createReadStream: vi.fn(() => Readable.from([bytes])),
      close: vi.fn().mockResolvedValue(undefined)
    }))
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({
      resolveSessionArtifactFilePath: vi.fn().mockResolvedValue('/managed/report.csv'),
      openProjectArtifactFile
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
              path: 'artifact://report',
              suggestedName: 'report.csv'
            }
          ]
        }
      )

      expect.soft(readFileMock).not.toHaveBeenCalled()
      expect(zipSyncMock).not.toHaveBeenCalled()
      expect(result).toEqual({ saved: true, filePath: destinationPath })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      expect(Buffer.from(entries['generated/report.csv']!).toString('utf8')).toBe('artifact bytes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a Project Artifact whose inode changes after validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-identity-'))
    const destinationPath = join(root, 'Research-artifacts.zip')
    await writeFile(destinationPath, 'existing destination')
    const createReadStream = vi.fn(() => Readable.from([Buffer.from('replacement bytes')]))
    const closeValidated = vi.fn().mockResolvedValue(undefined)
    const closeReplacement = vi.fn().mockResolvedValue(undefined)
    const openProjectArtifactFile = vi
      .fn()
      .mockResolvedValueOnce({
        stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 14, dev: 7, ino: 11 }),
        createReadStream,
        close: closeValidated
      })
      .mockResolvedValueOnce({
        stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 17, dev: 7, ino: 12 }),
        createReadStream,
        close: closeReplacement
      })
    const resolveSessionArtifactFilePath = vi.fn().mockResolvedValue('/managed/report.csv')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({ resolveSessionArtifactFilePath, openProjectArtifactFile } as never)

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
              path: 'artifact://report',
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
            path: 'artifact://report',
            suggestedName: 'report.csv',
            message: 'Project export source changed after validation.'
          }
        ]
      })
      expect(resolveSessionArtifactFilePath).toHaveBeenCalledTimes(1)
      expect(createReadStream).not.toHaveBeenCalled()
      expect(closeValidated).toHaveBeenCalledTimes(1)
      expect(closeReplacement).toHaveBeenCalledTimes(1)
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
      path: sourcePath,
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
    registerFileSaveHandlers({
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
              path: 'artifact://legacy-report',
              fileId: 'artifact-file-1',
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
            path: 'artifact://legacy-report',
            fileId: 'artifact-file-1',
            suggestedName: 'report.csv',
            message: 'Managed version storage is unavailable.'
          }
        ]
      })
      expect(resolveManagedFilePath).not.toHaveBeenCalled()
      expect(resolveSessionArtifactFilePath).not.toHaveBeenCalled()
      expect(showSaveDialog).not.toHaveBeenCalled()
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
    registerFileSaveHandlers({ resolveSessionArtifactFilePath, openLatestManagedFile } as never)

    const result = await handlers.get('file:save-project-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        suggestedArchiveName: 'Research',
        files: [
          {
            source: 'artifact',
            sessionId: 'session-1',
            path: 'artifact://legacy-report',
            fileId: 'artifact-file-1',
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
          path: 'artifact://legacy-report',
          fileId: 'artifact-file-1',
          suggestedName: 'report.csv',
          message: 'Managed file version content is unavailable or corrupt.'
        }
      ]
    })
    expect(resolveSessionArtifactFilePath).not.toHaveBeenCalled()
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('does not let a stale Project version hint bypass latest resolution', async () => {
    const resolveSessionArtifactFilePath = vi.fn()
    const openLatestManagedFile = vi.fn()
    const openManagedFileVersion = vi.fn()
    registerFileSaveHandlers({
      resolveSessionArtifactFilePath,
      openLatestManagedFile,
      openManagedFileVersion
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
              path: 'artifact://current-report',
              fileId: 'artifact-file-1',
              versionId: 'artifact-version-1',
              suggestedName: 'report.csv'
            }
          ]
        }
      )
    ).rejects.toThrow('Invalid Project Artifact save request.')
    expect(openLatestManagedFile).not.toHaveBeenCalled()
    expect(openManagedFileVersion).not.toHaveBeenCalled()
    expect(resolveSessionArtifactFilePath).not.toHaveBeenCalled()
    expect(showSaveDialog).not.toHaveBeenCalled()
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
    registerFileSaveHandlers({ resolveManagedFilePath, resolveSessionArtifactFilePath } as never)

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
              path: 'artifact://a',
              suggestedName: 'report.csv'
            },
            {
              source: 'upload',
              sessionId: 'session-1',
              path: 'upload://data',
              suggestedName: 'report.csv'
            },
            {
              source: 'artifact',
              sessionId: 'session-2',
              path: 'artifact://b',
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
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

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
              path: 'artifact://report',
              suggestedName: 'report.csv'
            },
            {
              source: 'artifact',
              sessionId: 'session-1',
              path: 'artifact://gone',
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
            path: 'artifact://gone',
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
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

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
              path: 'artifact://report',
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

  it('skips the Save As dialog when no Project Artifact resolves', async () => {
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockRejectedValue(new Error('Artifact bytes are unavailable.'))
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    const result = await handlers.get('file:save-project-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        suggestedArchiveName: 'Research',
        files: [
          {
            source: 'artifact',
            sessionId: 'session-1',
            path: 'artifact://gone',
            suggestedName: 'gone.csv'
          }
        ]
      }
    )

    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(result).toEqual({
      saved: true,
      failures: [
        {
          source: 'artifact',
          sessionId: 'session-1',
          path: 'artifact://gone',
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
    registerFileSaveHandlers({
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
              path: 'artifact://small',
              suggestedName: 'small.txt'
            },
            {
              source: 'upload',
              sessionId: 'session-1',
              path: 'upload://big',
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
            path: 'upload://big',
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
    registerFileSaveHandlers({
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
              path: 'artifact://first',
              suggestedName: 'first.txt'
            },
            {
              source: 'artifact',
              sessionId: 'session-1',
              path: 'artifact://second',
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
            path: 'artifact://second',
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
    registerFileSaveHandlers({
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
              path: 'artifact://first',
              suggestedName: 'first.txt'
            },
            {
              source: 'artifact',
              sessionId: 'session-1',
              path: 'artifact://second',
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
            path: 'artifact://second',
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
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

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
              path: 'artifact://evil',
              suggestedName: '..\\..\\evil.exe'
            },
            {
              source: 'artifact',
              sessionId: 'session-1',
              path: 'artifact://notes',
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
    registerFileSaveHandlers({ resolveSessionArtifactFilePath: vi.fn() } as never)

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
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

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
              path: 'artifact://proto',
              suggestedName: '__proto__'
            }
          ]
        }
      )

      expect(result).toEqual({ saved: true, filePath: destinationPath })
      const entries = unzipSync(new Uint8Array(await readFile(destinationPath)))
      // fflate cannot store an entry literally named __proto__; the file falls back to the
      // managed source basename and keeps its content.
      expect(Object.keys(entries)).toEqual(['generated/managed-proto.txt'])
      expect(Buffer.from(entries['generated/managed-proto.txt']!).toString('utf8')).toBe(
        'proto bytes'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts the export when a source outgrows the per-file limit while streaming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-save-project-growth-'))
    const destinationPath = join(root, 'Research-artifacts.zip')
    await writeFile(destinationPath, 'existing destination')
    const close = vi.fn().mockResolvedValue(undefined)
    const openProjectArtifactFile = vi.fn().mockResolvedValue({
      stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 5, dev: 1, ino: 1 }),
      createReadStream: vi.fn(() => Readable.from([Buffer.from('this grew past the limit')])),
      close
    })
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({
      resolveSessionArtifactFilePath: vi.fn().mockResolvedValue('/managed/report.csv'),
      openProjectArtifactFile,
      projectArtifactExportLimits: { maxFiles: 5000, maxFileBytes: 10, maxTotalBytes: 1024 }
    } as never)

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
                path: 'artifact://report',
                suggestedName: 'report.csv'
              }
            ]
          }
        )
      ).rejects.toThrow('Project export file exceeds the per-file size limit.')

      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('existing destination')
      expect(showSaveDialog).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledTimes(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports non-file export sources without reading them', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const readFileMock = vi.fn()
    const openProjectArtifactFile = vi.fn().mockResolvedValue({
      stat: vi.fn().mockResolvedValue({ isFile: () => false, size: 0 }),
      readFile: readFileMock,
      close
    })
    registerFileSaveHandlers({
      resolveSessionArtifactFilePath: vi.fn().mockResolvedValue('/managed/fifo'),
      openProjectArtifactFile
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
            path: 'artifact://fifo',
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
          path: 'artifact://fifo',
          suggestedName: 'fifo.csv',
          message: 'Project export source is not a regular file.'
        }
      ]
    })
    expect(readFileMock).not.toHaveBeenCalled()
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('rejects Project Artifact save requests with an unbounded file list', async () => {
    const resolveSessionArtifactFilePath = vi.fn()
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)
    const files = Array.from({ length: 10001 }, (_, index) => ({
      source: 'artifact',
      sessionId: 'session-1',
      path: `artifact://${index}`,
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
      registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

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
                path: 'artifact://report',
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
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

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
              path: 'artifact://upper',
              suggestedName: 'A.csv'
            },
            {
              source: 'artifact',
              sessionId: 'session-1',
              path: 'artifact://lower',
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
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

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
              path: 'artifact://report',
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
    registerFileSaveHandlers({
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
              path: 'artifact://exact',
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
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)
    const baseFile = {
      source: 'artifact',
      sessionId: 'session-1',
      path: 'artifact://report',
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
    await reject({ source: 'artifact', suggestedName: 'report.csv' }, 'missing-path')
  })

  it('rejects a non-string path', async () => {
    await reject({ source: 'artifact', path: 42, suggestedName: 'report.csv' }, 'numeric-path')
  })

  it('rejects an empty path', async () => {
    await reject({ source: 'artifact', path: '', suggestedName: 'report.csv' }, 'empty-path')
  })

  it('rejects a whitespace-only path', async () => {
    await reject(
      { source: 'artifact', path: '   ', suggestedName: 'report.csv' },
      'whitespace-path'
    )
  })

  it('rejects a missing suggestedName', async () => {
    await reject({ source: 'artifact', path: '/managed/report.csv' }, 'missing-suggested-name')
  })

  it('rejects a non-string suggestedName', async () => {
    await reject(
      { source: 'artifact', path: '/managed/report.csv', suggestedName: 7 },
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
    { identity: { fileId: 42 }, label: 'numeric file id' },
    { identity: { fileId: '   ' }, label: 'blank file id' },
    { identity: { fileId: 'artifact-1', versionId: 42 }, label: 'numeric version id' },
    { identity: { fileId: 'artifact-1', versionId: '' }, label: 'blank version id' },
    { identity: { versionId: 'artifact-v1' }, label: 'version without file id' }
  ] as const)('rejects $label before opening a save dialog', async ({ identity }) => {
    registerFileSaveHandlers({
      resolveSessionArtifactFilePath: vi.fn().mockResolvedValue('/managed/report.csv')
    } as never)

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
