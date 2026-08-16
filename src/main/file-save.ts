import { BrowserWindow, app, dialog, type OpenDialogOptions } from 'electron'
import { zipSync } from 'fflate'

import { ipcMainHandle } from './ipc-handler-registry'
import { constants } from 'node:fs'
import { open, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult,
  SaveProjectArtifactFailure,
  SaveProjectArtifactsRequest,
  SaveProjectArtifactsResult,
  SaveSessionArtifactsRequest,
  SaveSessionArtifactsResult
} from '../shared/file-save'

type RegisterFileSaveHandlersOptions = {
  resolveManagedFilePath?: (
    source: SaveManagedFileRequest['source'],
    request: { path: string; projectId?: string; sessionId?: string }
  ) => Promise<string>
  resolveSessionArtifactFilePath?: (
    projectId: string,
    sessionId: string,
    path: string
  ) => Promise<string>
  openManagedFile?: (sourcePath: string) => Promise<ManagedFileHandle>
  openProjectArtifactFile?: (sourcePath: string) => Promise<ProjectArtifactFileHandle>
  projectArtifactExportLimits?: ProjectArtifactExportLimits
}

type ProjectArtifactExportLimits = {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

// Structural subset of fs FileHandle: the size check and the read must observe one open file.
type ProjectArtifactFileHandle = {
  stat: () => Promise<{ isFile: () => boolean; size: number }>
  readFile: () => Promise<Uint8Array>
  close: () => Promise<void>
}

// Project exports buffer every file plus one zipSync output in main-process memory; cap the
// per-file and cumulative bytes so a batch of multi-GB uploads cannot exhaust the process.
const PROJECT_ARTIFACT_EXPORT_LIMITS: ProjectArtifactExportLimits = {
  maxFiles: 5000,
  maxFileBytes: 1024 ** 3,
  maxTotalBytes: 2 * 1024 ** 3
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
      request.source !== 'notebook-input' &&
      request.source !== 'local') ||
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

const assertSaveProjectArtifactsRequest = (request: SaveProjectArtifactsRequest): void => {
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof request.projectId !== 'string' ||
    request.projectId.trim().length === 0 ||
    typeof request.suggestedArchiveName !== 'string' ||
    !Array.isArray(request.files) ||
    request.files.length === 0 ||
    request.files.length > 10000 ||
    request.files.some(
      (file) =>
        typeof file !== 'object' ||
        file === null ||
        (file.source !== 'artifact' && file.source !== 'upload') ||
        typeof file.sessionId !== 'string' ||
        file.sessionId.trim().length === 0 ||
        typeof file.path !== 'string' ||
        file.path.trim().length === 0 ||
        typeof file.suggestedName !== 'string'
    )
  ) {
    throw new Error('Invalid Project Artifact save request.')
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

// Pins the export source to one open handle so the size checks and the read observe the same
// file, mirroring the inode-pinning approach of openManagedFile.
const openProjectArtifactFile = (sourcePath: string): Promise<ProjectArtifactFileHandle> =>
  open(sourcePath, 'r')

const isAlreadyExistsError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'EEXIST'

const addFilenameCollisionSuffix = (filename: string, suffix: number): string => {
  const extension = extname(filename)
  const stem = basename(filename, extension)
  return `${stem} (${suffix})${extension}`
}

// Zip entries share one archive-wide namespace; claim the first free name with the same collision
// suffix scheme used for on-disk batch exports. The suffix applies to the file name part only so
// category prefixes like 'generated/' survive renaming. Name claims compare case-insensitively
// because the archive may be extracted onto case-insensitive file systems.
const claimZipEntryName = (takenNames: ReadonlySet<string>, entryName: string): string => {
  const slashIndex = entryName.lastIndexOf('/')
  const directory = slashIndex === -1 ? '' : entryName.slice(0, slashIndex + 1)
  const fileName = slashIndex === -1 ? entryName : entryName.slice(slashIndex + 1)
  for (let suffix = 1; ; suffix += 1) {
    const candidate =
      suffix === 1 ? entryName : `${directory}${addFilenameCollisionSuffix(fileName, suffix)}`
    if (!takenNames.has(candidate.toLowerCase())) return candidate
  }
}

// fflate keeps archive entries in a plain object, where assigning '__proto__' writes to the
// prototype instead of creating an entry. Rename that one dangerous key; content is preserved.
const ZIP_FORBIDDEN_ENTRY_NAMES = new Set(['__proto__'])

// Zip entry names must also be safe on Windows: normalize backslashes before basename so a
// suggestedName like '..\..\evil.exe' collapses to a plain file name, then strip the characters
// Windows rejects in file names.
const getSafeZipEntryName = (suggestedName: string, sourcePath: string): string => {
  const safeName = getSafeFilename(suggestedName.replaceAll('\\', '/'), sourcePath)
    // Windows rejects these characters in file names; control characters are never valid.
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[<>:"|?*\x00-\x1f]/g, '-')
  if (!ZIP_FORBIDDEN_ENTRY_NAMES.has(safeName)) return safeName
  const fallback = basename(sourcePath)
  return ZIP_FORBIDDEN_ENTRY_NAMES.has(fallback) ? 'proto' : fallback
}

const getSafeZipBaseName = (suggestedArchiveName: string): string => {
  const trimmed = suggestedArchiveName
    .trim()
    .replaceAll('/', '-')
    .replaceAll('\\', '-')
    // Windows rejects these characters in file names; control characters are never valid.
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[<>:"|?*\x00-\x1f]/g, '-')
  return trimmed.length > 0 && trimmed !== '.' && trimmed !== '..' ? trimmed : 'project'
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
    case 'text/x-python':
      return 'py'
    case 'text/x-r':
      return 'R'
    case 'text/x-sh':
      return 'sh'
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
  const resolveProjectArtifact = (
    file: { sessionId: string; path: string },
    projectId: string
  ): Promise<string> => {
    const resolver = options.resolveSessionArtifactFilePath
    if (!resolver) throw new Error('Session Artifact file resolver is not configured.')
    return resolver(projectId, file.sessionId, file.path)
  }

  const resolveManagedUpload = (
    file: { sessionId: string; path: string },
    projectId: string
  ): Promise<string> => {
    const resolver = options.resolveManagedFilePath
    if (!resolver) throw new Error('Managed file resolver is not configured.')
    return resolver('upload', { path: file.path, projectId, sessionId: file.sessionId })
  }

  ipcMainHandle(
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
  ipcMainHandle(
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

  ipcMainHandle(
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

  // Project-wide export packs every Artifact and Upload into one zip, grouped under uploads/ and
  // generated/ by source.
  ipcMainHandle(
    'file:save-project-artifacts',
    async (event, request: SaveProjectArtifactsRequest): Promise<SaveProjectArtifactsResult> => {
      assertSaveProjectArtifactsRequest(request)

      const limits = options.projectArtifactExportLimits ?? PROJECT_ARTIFACT_EXPORT_LIMITS
      // Null-prototype map: entry names are renderer-controlled, so a suggestedName like
      // '__proto__' must become a real own key instead of polluting the prototype chain.
      const zipEntries: Record<string, Uint8Array> = Object.create(null)
      const takenNames = new Set<string>()
      const failures: SaveProjectArtifactFailure[] = []
      let totalBytes = 0
      for (const file of request.files) {
        let exportFile: ProjectArtifactFileHandle | undefined
        try {
          if (takenNames.size >= limits.maxFiles) {
            throw new Error('Project export exceeds the file-count limit.')
          }
          const sourcePath =
            file.source === 'upload'
              ? await resolveManagedUpload(file, request.projectId)
              : await resolveProjectArtifact(file, request.projectId)
          exportFile = await (options.openProjectArtifactFile ?? openProjectArtifactFile)(
            sourcePath
          )
          const metadata = await exportFile.stat()
          if (!metadata.isFile()) {
            throw new Error('Project export source is not a regular file.')
          }
          if (metadata.size > limits.maxFileBytes) {
            throw new Error('Project export file exceeds the per-file size limit.')
          }
          if (totalBytes + metadata.size > limits.maxTotalBytes) {
            throw new Error('Project export exceeds the total size limit.')
          }
          // Entries are grouped by origin under constant directory prefixes; the file name part
          // is sanitized before prefixing and collision suffixes apply within each category.
          const categoryDirectory = file.source === 'upload' ? 'uploads' : 'generated'
          const entryName = claimZipEntryName(
            takenNames,
            `${categoryDirectory}/${getSafeZipEntryName(file.suggestedName, sourcePath)}`
          )
          const bytes = new Uint8Array(await exportFile.readFile())
          // Re-check the bytes actually read: the source may have grown between stat and read.
          if (bytes.byteLength > limits.maxFileBytes) {
            throw new Error('Project export file exceeds the per-file size limit.')
          }
          if (totalBytes + bytes.byteLength > limits.maxTotalBytes) {
            throw new Error('Project export exceeds the total size limit.')
          }
          zipEntries[entryName] = bytes
          // Claim checks are case-insensitive; the entry itself keeps its original casing.
          takenNames.add(entryName.toLowerCase())
          totalBytes += bytes.byteLength
        } catch (error) {
          failures.push({
            ...file,
            message: error instanceof Error ? error.message : String(error)
          })
        } finally {
          await exportFile?.close()
        }
      }
      if (takenNames.size === 0) {
        return { saved: true, ...(failures.length > 0 ? { failures } : {}) }
      }

      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      const dialogOptions = {
        defaultPath: join(
          app.getPath('downloads'),
          `${getSafeZipBaseName(request.suggestedArchiveName)}-artifacts.zip`
        ),
        title: 'Download project artifacts',
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      }
      const { canceled, filePath } = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)
      if (canceled || !filePath) return { saved: false }

      // Compress only after the user confirms the destination so a canceled dialog costs nothing.
      await writeFile(filePath, zipSync(zipEntries, { level: 6 }))
      return { saved: true, filePath, ...(failures.length > 0 ? { failures } : {}) }
    }
  )
}

export { registerFileSaveHandlers }
export type { RegisterFileSaveHandlersOptions }
