import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { constants } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult
} from '../shared/file-save'

type RegisterFileSaveHandlersOptions = {
  resolveManagedFilePath?: (
    source: SaveManagedFileRequest['source'],
    request: { path: string }
  ) => Promise<string>
  openManagedFile?: (sourcePath: string) => Promise<ManagedFileHandle>
}

type ManagedFileHandle = {
  copyTo: (destinationPath: string) => Promise<void>
  close: () => Promise<void>
}

// IPC input is renderer-controlled; reject malformed sources and paths before any filesystem work.
const assertSaveManagedFileRequest = (request: SaveManagedFileRequest): void => {
  if (
    typeof request !== 'object' ||
    request === null ||
    (request.source !== 'artifact' && request.source !== 'upload') ||
    typeof request.path !== 'string' ||
    request.path.trim().length === 0 ||
    typeof request.suggestedName !== 'string'
  ) {
    throw new Error('Invalid managed file save request.')
  }
}

// Holds the validated source inode across Save As so a pending artifact rename cannot change identity.
const openManagedFile = async (sourcePath: string): Promise<ManagedFileHandle> => {
  const sourceHandle = await open(sourcePath, 'r')

  return {
    copyTo: async (destinationPath) => {
      // Open without truncation, then check and write through the same handle to prevent path swaps.
      const destinationHandle = await open(
        destinationPath,
        constants.O_CREAT | constants.O_RDWR,
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
}

export { registerFileSaveHandlers }
export type { RegisterFileSaveHandlersOptions }
