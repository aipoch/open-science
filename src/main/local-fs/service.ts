import { hostname, userInfo } from 'node:os'
import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { app, shell } from 'electron'

import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type { LocalDirEntry, LocalDirListing, LocalRoots } from '../../shared/local-fs'
import { LOCAL_DIR_ENTRY_CAP, sortLocalEntries, validateLocalPath } from '../../shared/local-fs'
import { readBoundedManagedFilePreview } from '../managed-file-preview'

// Builds a user-facing machine name from the OS hostname (stripping a trailing ".local" that macOS
// appends) with a possessive owner prefix when the login name is available — e.g. "roxi's MacBook".
const buildMachineName = (): string => {
  const raw = hostname().replace(/\.local$/i, '')
  let owner = ''
  try {
    owner = userInfo().username
  } catch {
    // userInfo() throws when there is no OS user record (e.g. some CI); fall back to the bare host.
  }
  return owner ? `${owner}'s ${raw}` : raw
}

// Throws a tagged error when the path fails the shared validation (non-absolute / control chars).
const assertValidLocalPath = (path: string): void => {
  const problem = validateLocalPath(path, process.platform)
  if (problem === 'not_absolute') throw new Error('Local path must be absolute.')
  if (problem === 'control_chars') throw new Error('Local path contains invalid characters.')
}

// Service for browsing and previewing arbitrary local files. Unlike the artifact/upload readers,
// this deliberately does NOT confine paths to a storage root: the feature's contract is
// "Home start, full-disk navigable". Path validation rejects only malformed input; sensitive-file
// warnings are surfaced in the renderer (see isSensitiveLocalPath).
export class LocalFsService {
  // Absolute paths for the browser's initial location and "Go to → Home".
  getRoots(): LocalRoots {
    return { home: app.getPath('home'), machineName: buildMachineName() }
  }

  // Lists one directory. Resolves symlinks/.. via realpath, sorts dirs-first, caps entry count.
  async listDir(path: string): Promise<LocalDirListing> {
    assertValidLocalPath(path)
    const resolvedPath = await realpath(path)
    const dirents = await readdir(resolvedPath, { withFileTypes: true })
    const truncated = dirents.length > LOCAL_DIR_ENTRY_CAP
    const capped = truncated ? dirents.slice(0, LOCAL_DIR_ENTRY_CAP) : dirents

    const entries: LocalDirEntry[] = []
    for (const dirent of capped) {
      const isDirectory = dirent.isDirectory()
      // Stat each entry for size/mtime; skip entries that vanish or deny access mid-listing so one
      // unreadable file never fails the whole directory.
      try {
        const entryStat = await stat(join(resolvedPath, dirent.name))
        entries.push({
          name: dirent.name,
          isDirectory: isDirectory || entryStat.isDirectory(),
          size: entryStat.isDirectory() ? 0 : entryStat.size,
          mtimeMs: Math.round(entryStat.mtimeMs)
        })
      } catch {
        entries.push({ name: dirent.name, isDirectory, size: 0, mtimeMs: 0 })
      }
    }

    return { entries: sortLocalEntries(entries), truncated, resolvedPath }
  }

  // Validates + canonicalizes an absolute file path, asserting it is a regular file. Shared by the
  // bounded preview reader and the streaming managed-preview resolver (binary renderers).
  async resolveFilePath(request: { path: string }): Promise<string> {
    assertValidLocalPath(request.path)
    const resolvedPath = await realpath(request.path)
    const fileStat = await stat(resolvedPath)
    if (!fileStat.isFile()) throw new Error('Local preview path is not a file.')
    return resolvedPath
  }

  // Reads a bounded preview of one local file, reusing the shared bounded reader.
  async readPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult> {
    const resolvedPath = await this.resolveFilePath(request)
    return readBoundedManagedFilePreview(resolvedPath, request, 'Invalid local preview encoding.')
  }

  // Reveals a file in the OS file manager (Finder / Explorer).
  revealInFolder(path: string): void {
    assertValidLocalPath(path)
    shell.showItemInFolder(path)
  }

  // Opens a file with the OS default application. Returns the shell error string, or '' on success.
  async openPath(path: string): Promise<string> {
    assertValidLocalPath(path)
    return shell.openPath(path)
  }
}
