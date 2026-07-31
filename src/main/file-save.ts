import { BrowserWindow, app, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { constants } from 'node:fs'
import { open, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult,
  SaveSessionArtifactsRequest,
  SaveSessionArtifactsResult
} from '../shared/file-save'

type RegisterFileSaveHandlersOptions = {
  resolveManagedFilePath?: (
    source: SaveManagedFileRequest['source'],
    request: { path: string }
  ) => Promise<string>
  resolveSessionArtifactFilePath?: (
    projectId: string,
    sessionId: string,
    path: string
  ) => Promise<string>
  openManagedFile?: (sourcePath: string) => Promise<ManagedFileHandle>
}

type ManagedFileHandle = {
  copyTo: (destinationPath: string, options?: { exclusive?: boolean }) => Promise<void>
  close: () => Promise<void>
}

// IPC input is renderer-controlled; reject malformed sources and paths before any filesystem work.
const assertSaveManagedFileRequest = (request: SaveManagedFileRequest): void => {
  if (
    typeof request !== 'object' ||
    request === null ||
    (request.source !== 'artifact' &&
      request.source !== 'upload' &&
      request.source !== 'notebook-input') ||
    typeof request.path !== 'string' ||
    request.path.trim().length === 0 ||
    typeof request.suggestedName !== 'string'
  ) {
    throw new Error('Invalid managed file save request.')
  }
}

const assertSaveSessionArtifactsRequest = (request: SaveSessionArtifactsRequest): void => {
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof request.projectId !== 'string' ||
    request.projectId.trim().length === 0 ||
    typeof request.sessionId !== 'string' ||
    request.sessionId.trim().length === 0 ||
    !Array.isArray(request.files) ||
    request.files.length === 0 ||
    request.files.some(
      (file) =>
        typeof file !== 'object' ||
        file === null ||
        typeof file.path !== 'string' ||
        file.path.trim().length === 0 ||
        typeof file.suggestedName !== 'string'
    )
  ) {
    throw new Error('Invalid Session Artifact save request.')
  }
}

// Holds the validated source inode across Save As so a pending artifact rename cannot change identity.
const openManagedFile = async (sourcePath: string): Promise<ManagedFileHandle> => {
  const sourceHandle = await open(sourcePath, 'r')

  return {
    copyTo: async (destinationPath, options) => {
      // Open without truncation, then check and write through the same handle to prevent path swaps.
      const destinationHandle = await open(
        destinationPath,
        constants.O_CREAT | constants.O_RDWR | (options?.exclusive ? constants.O_EXCL : 0),
        0o666
      )

      try {
        const sourceStat = await sourceHandle.stat()
        const destinationStat = await destinationHandle.stat()
        if (destinationStat.dev === sourceStat.dev && destinationStat.ino === sourceStat.ino) {
          throw new Error('Cannot save a managed file over its source.')
        }

        await destinationHandle.truncate(0)
        await pipeline(
          sourceHandle.createReadStream({ autoClose: false, start: 0 }),
          destinationHandle.createWriteStream({ autoClose: true, start: 0 })
        )
      } finally {
        await destinationHandle.close()
      }
    },
    close: () => sourceHandle.close()
  }
}

const isAlreadyExistsError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'EEXIST'

const addFilenameCollisionSuffix = (filename: string, suffix: number): string => {
  const extension = extname(filename)
  const stem = basename(filename, extension)
  return `${stem} (${suffix})${extension}`
}

const getSafeFilename = (suggestedName: string, sourcePath: string): string => {
  const requestedBaseName = basename(suggestedName.trim())
  return requestedBaseName && requestedBaseName !== '.' && requestedBaseName !== '..'
    ? requestedBaseName
    : basename(sourcePath)
}

// Atomically claims the first available filename so batch exports never overwrite existing files.
const copyToAvailableDestination = async (
  managedFile: ManagedFileHandle,
  destinationDirectory: string,
  safeName: string
): Promise<string> => {
  for (let suffix = 1; ; suffix += 1) {
    const filename = suffix === 1 ? safeName : addFilenameCollisionSuffix(safeName, suffix)
    const destinationPath = join(destinationDirectory, filename)
    try {
      await managedFile.copyTo(destinationPath, { exclusive: true })
      return destinationPath
    } catch (error) {
      if (isAlreadyExistsError(error)) continue
      await rm(destinationPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

const extensionForMime = (mimeType: string): string | undefined => {
  switch (mimeType) {
    case 'image/svg+xml':
      return 'svg'
    case 'image/png':
      return 'png'
    case 'text/plain':
      return 'txt'
    case 'text/csv':
      return 'csv'
    case 'text/tab-separated-values':
      return 'tsv'
    case 'text/markdown':
      return 'md'
    default:
      return undefined
  }
}

const registerFileSaveHandlers = (options: RegisterFileSaveHandlersOptions = {}): void => {
  ipcMain.handle(
    'file:save-blob',
    async (event, request: SaveBlobFileRequest): Promise<SaveBlobFileResult> => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      const extension = extensionForMime(request.mimeType)
      const dialogOptions = {
        defaultPath: request.suggestedName,
        filters: extension
          ? [{ name: extension.toUpperCase(), extensions: [extension] }]
          : undefined
      }
      const { canceled, filePath } = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)

      if (canceled || !filePath) {
        return { saved: false }
      }

      await writeFile(filePath, Buffer.from(request.data))
      return { saved: true, filePath }
    }
  )

  // Managed-file export stays in main so large files never pass through renderer memory.
  ipcMain.handle(
    'file:save-managed',
    async (event, request: SaveManagedFileRequest): Promise<SaveManagedFileResult> => {
      if (!options.resolveManagedFilePath) {
        throw new Error('Managed file resolver is not configured.')
      }

      assertSaveManagedFileRequest(request)
      const sourcePath = await options.resolveManagedFilePath(request.source, {
        path: request.path
      })
      const requestedBaseName = basename(request.suggestedName.trim())
      const safeName =
        requestedBaseName && requestedBaseName !== '.' && requestedBaseName !== '..'
          ? requestedBaseName
          : basename(sourcePath)
      const dialogOptions = {
        defaultPath: join(app.getPath('downloads'), safeName),
        title: 'Save file'
      }
      const managedFile = await (options.openManagedFile ?? openManagedFile)(sourcePath)

      try {
        const parentWindow = BrowserWindow.fromWebContents(event.sender)
        const { canceled, filePath } = parentWindow
          ? await dialog.showSaveDialog(parentWindow, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions)

        if (canceled || !filePath) return { saved: false }

        await managedFile.copyTo(filePath)
        return { saved: true, filePath }
      } finally {
        await managedFile.close()
      }
    }
  )

  ipcMain.handle(
    'file:save-session-artifacts',
    async (event, request: SaveSessionArtifactsRequest): Promise<SaveSessionArtifactsResult> => {
      const resolveSessionArtifactFilePath = options.resolveSessionArtifactFilePath
      if (!resolveSessionArtifactFilePath) {
        throw new Error('Session Artifact file resolver is not configured.')
      }

      assertSaveSessionArtifactsRequest(request)
      const parentWindow = BrowserWindow.fromWebContents(event.sender)

      if (request.files.length === 1) {
        const [file] = request.files
        const sourcePath = await resolveSessionArtifactFilePath(
          request.projectId,
          request.sessionId,
          file.path
        )
        const safeName = getSafeFilename(file.suggestedName, sourcePath)
        const dialogOptions = {
          defaultPath: join(app.getPath('downloads'), safeName),
          title: 'Save artifact'
        }
        const managedFile = await (options.openManagedFile ?? openManagedFile)(sourcePath)

        try {
          const { canceled, filePath } = parentWindow
            ? await dialog.showSaveDialog(parentWindow, dialogOptions)
            : await dialog.showSaveDialog(dialogOptions)

          if (canceled || !filePath) return { saved: false }

          await managedFile.copyTo(filePath)
          return { saved: true, filePaths: [filePath] }
        } finally {
          await managedFile.close()
        }
      }

      const directoryDialogOptions: OpenDialogOptions = {
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose where to save artifacts'
      }
      const { canceled, filePaths } = parentWindow
        ? await dialog.showOpenDialog(parentWindow, directoryDialogOptions)
        : await dialog.showOpenDialog(directoryDialogOptions)
      const destinationDirectory = filePaths[0]
      if (canceled || !destinationDirectory) return { saved: false }

      const savedPaths: string[] = []
      const failures: Array<{ path: string; suggestedName: string; message: string }> = []
      for (const file of request.files) {
        let managedFile: ManagedFileHandle | undefined
        try {
          const sourcePath = await resolveSessionArtifactFilePath(
            request.projectId,
            request.sessionId,
            file.path
          )
          const safeName = getSafeFilename(file.suggestedName, sourcePath)
          managedFile = await (options.openManagedFile ?? openManagedFile)(sourcePath)
          savedPaths.push(
            await copyToAvailableDestination(managedFile, destinationDirectory, safeName)
          )
        } catch (error) {
          failures.push({
            ...file,
            message: error instanceof Error ? error.message : String(error)
          })
        } finally {
          await managedFile?.close()
        }
      }
      return {
        saved: true,
        filePaths: savedPaths,
        ...(failures.length > 0 ? { failures } : {})
      }
    }
  )
}

export { registerFileSaveHandlers }
export type { RegisterFileSaveHandlersOptions }
