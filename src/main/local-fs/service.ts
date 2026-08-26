import { hostname, userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'

import { app, shell } from 'electron'

import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type {
  GrantLocalRootRequest,
  GrantedLocalRoot,
  GrantedLocalRootAccess,
  LocalDirEntry,
  LocalDirListing,
  LocalDrive,
  LocalRoots,
  RemoveGrantedLocalRootRequest,
  SetGrantedLocalRootAccessRequest
} from '../../shared/local-fs'
import {
  LOCAL_DIR_ENTRY_CAP,
  sortLocalEntries,
  validateGrantCandidate,
  validateLocalPath
} from '../../shared/local-fs'
import { readBoundedManagedFilePreview } from '../managed-file-preview'
import { isWindowsPlatform, listWindowsDrives } from './windows-drive-listing'

const LOCAL_DIR_STAT_CONCURRENCY = 16

// The slice of the granted-roots repository the feature persists through. Structural so tests can
// inject an in-memory store; production wires the SQLite-backed GrantedLocalRootsRepository.
export type GrantedLocalRootsStore = {
  list: () => Promise<GrantedLocalRoot[]>
  // Insert-or-update-by-path: re-granting an already granted path updates its access while keeping
  // the existing id. Returns the stored row.
  upsertByPath: (root: GrantedLocalRoot) => Promise<GrantedLocalRoot>
  setAccess: (id: string, access: GrantedLocalRootAccess) => Promise<void>
  remove: (id: string) => Promise<void>
}

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

// Guard against crafted renderer payloads: only the two declared access levels are persisted.
const assertValidAccess = (access: GrantedLocalRootAccess): void => {
  if (access !== 'ro' && access !== 'rw') throw new Error('Grant access must be "ro" or "rw".')
}

// Service for browsing and previewing arbitrary local files. Unlike the artifact/upload readers,
// this deliberately does NOT confine paths to a storage root: the feature's contract is
// "Home start, full-disk navigable". Path validation rejects only malformed input; sensitive-file
// warnings are surfaced in the renderer (see isSensitiveLocalPath).
export class LocalFsService {
  // The granted-roots store is optional so existing call sites/tests that only browse keep working;
  // granted-root operations fail loudly when persistence is not wired.
  constructor(private readonly grantedRootsStore?: GrantedLocalRootsStore) {}

  // Absolute paths for the browser's initial location and "Go to → Home".
  getRoots(): LocalRoots {
    return { home: app.getPath('home'), machineName: buildMachineName() }
  }

  // Mounted drives/volumes for the browsers' drive switchers. Windows probes mounted drive letters;
  // darwin lists /Volumes; other POSIX checks conventional mount parents.
  async listDrives(): Promise<LocalDrive[]> {
    if (isWindowsPlatform(process.platform)) return listWindowsDrives()
    if (process.platform === 'darwin') {
      const volumes = await this.listMountEntries('/Volumes')
      // The boot volume appears in /Volumes as a symlink to /. Label the root entry with the
      // boot volume's name ("/" alone tells the user nothing) and drop the duplicate, so the
      // switcher shows one entry per volume.
      let bootLabel = '/'
      const rest: LocalDrive[] = []
      for (const volume of volumes) {
        try {
          if ((await realpath(volume.path)) === '/') {
            bootLabel = volume.label
            continue
          }
        } catch {
          // Unresolvable symlink: keep it as its own entry rather than dropping a volume.
        }
        rest.push(volume)
      }
      return [{ path: '/', label: bootLabel }, ...rest]
    }
    let username = ''
    try {
      username = userInfo().username
    } catch {
      // No OS user record (some CI): skip the per-user mount parents, keep /mnt.
    }
    const parents = [...(username ? [`/media/${username}`, `/run/media/${username}`] : []), '/mnt']
    const mounted = await Promise.all(parents.map((parent) => this.listMountEntries(parent)))
    return [{ path: '/', label: '/' }, ...mounted.flat()]
  }

  // Directory entries of a mount-point parent as drives; an unreadable or missing parent (the
  // common case — most machines have no /mnt mounts) simply contributes nothing. Symlinks count:
  // macOS represents the boot volume in /Volumes as a symlink.
  private async listMountEntries(parent: string): Promise<LocalDrive[]> {
    try {
      const dirents = await readdir(parent, { withFileTypes: true })
      return dirents
        .filter((dirent) => dirent.isDirectory() || dirent.isSymbolicLink())
        .map((dirent) => ({ path: posix.join(parent, dirent.name), label: dirent.name }))
    } catch {
      return []
    }
  }

  private requireGrantedRootsStore(): GrantedLocalRootsStore {
    if (!this.grantedRootsStore) throw new Error('Granted local roots store is not configured.')
    return this.grantedRootsStore
  }

  // Returns the folders the user has granted the app access to.
  async listGrantedRoots(): Promise<GrantedLocalRoot[]> {
    return this.requireGrantedRootsStore().list()
  }

  // Grants a folder (or updates its access when already granted) and returns the updated list.
  // The candidate is canonicalized with realpath before validation and storage, so the recorded
  // path is the same form the linked-folder resolver later confines against.
  async grantRoot(request: GrantLocalRootRequest): Promise<GrantedLocalRoot[]> {
    const store = this.requireGrantedRootsStore()
    assertValidAccess(request.access)
    assertValidLocalPath(request.path)
    const resolvedPath = await realpath(request.path)
    // Home must be canonicalized too: app.getPath('home') may sit behind a symlink (/var on
    // macOS, /home mounts on some Linux setups), and comparing the realpath'd candidate against
    // the verbatim string would fail the is-home check.
    const resolvedHome = await realpath(this.getRoots().home)
    const verdict = validateGrantCandidate(resolvedPath, resolvedHome, process.platform)
    if (!verdict.ok) {
      if (verdict.reason === 'is-home')
        throw new Error('The home folder is already browsable; it cannot be granted.')
      throw new Error('Local path must be absolute.')
    }
    // De-dupe on the resolved path: re-granting an already granted folder updates its access and
    // keeps the existing id (the store upserts by path).
    await store.upsertByPath({
      id: randomUUID(),
      path: resolvedPath,
      name: basename(resolvedPath),
      access: request.access
    })
    return store.list()
  }

  // Changes the access level of one granted root and returns the updated list.
  async setGrantedRootAccess(
    request: SetGrantedLocalRootAccessRequest
  ): Promise<GrantedLocalRoot[]> {
    const store = this.requireGrantedRootsStore()
    assertValidAccess(request.access)
    const roots = await store.list()
    if (!roots.some((root) => root.id === request.id))
      throw new Error(`Unknown granted root: ${request.id}`)
    await store.setAccess(request.id, request.access)
    return store.list()
  }

  // Revokes one granted root and returns the updated list.
  async removeGrantedRoot(request: RemoveGrantedLocalRootRequest): Promise<GrantedLocalRoot[]> {
    const store = this.requireGrantedRootsStore()
    await store.remove(request.id)
    return store.list()
  }

  // Lists one directory. Resolves symlinks/.. via realpath, sorts dirs-first, caps entry count.
  async listDir(path: string): Promise<LocalDirListing> {
    assertValidLocalPath(path)
    const resolvedPath = await realpath(path)
    const dirents = await readdir(resolvedPath, { withFileTypes: true })
    const truncated = dirents.length > LOCAL_DIR_ENTRY_CAP
    // readdir order is filesystem-dependent. Sort the inexpensive Dirent metadata before applying
    // the cap so repeated listings select the same visible subset. Keep symlinks ahead of ordinary
    // files so directory targets remain eligible, then resolve only the selected entries below.
    dirents.sort((a, b) => {
      const aRank = a.isDirectory() ? 0 : a.isSymbolicLink() ? 1 : 2
      const bRank = b.isDirectory() ? 0 : b.isSymbolicLink() ? 1 : 2
      if (aRank !== bRank) return aRank - bRank
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    const capped = truncated ? dirents.slice(0, LOCAL_DIR_ENTRY_CAP) : dirents

    const entries: LocalDirEntry[] = []
    for (let offset = 0; offset < capped.length; offset += LOCAL_DIR_STAT_CONCURRENCY) {
      const batch = await Promise.all(
        capped.slice(offset, offset + LOCAL_DIR_STAT_CONCURRENCY).map(async (dirent) => {
          const isDirectory = dirent.isDirectory()
          // Stat each entry for size/mtime; skip entries that vanish or deny access mid-listing so
          // one unreadable file never fails the whole directory.
          try {
            const entryStat = await stat(join(resolvedPath, dirent.name))
            return {
              name: dirent.name,
              isDirectory: isDirectory || entryStat.isDirectory(),
              size: entryStat.isDirectory() ? 0 : entryStat.size,
              mtimeMs: Math.round(entryStat.mtimeMs)
            }
          } catch {
            return { name: dirent.name, isDirectory, size: 0, mtimeMs: 0 }
          }
        })
      )
      entries.push(...batch)
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
