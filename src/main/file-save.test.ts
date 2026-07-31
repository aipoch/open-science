import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const downloadsPath = join('/Users/example', 'Downloads')

const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
const showSaveDialog = vi.hoisted(() => vi.fn())
const showOpenDialog = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/Users/example/Downloads') },
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
    showOpenDialog.mockReset()
    showSaveDialog.mockReset()
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

  it('maps text/plain to the txt extension filter', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'notes.txt', mimeType: 'text/plain', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'TXT', extensions: ['txt'] }]
      })
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
