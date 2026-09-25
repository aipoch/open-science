import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse
} from '@agentclientprotocol/sdk'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { GrantedLocalRoot } from '../../shared/local-fs'
import { isPathInsideWorkspace } from './workspace-path'

type GrantedRoot = Pick<GrantedLocalRoot, 'path' | 'access'>

// Resolve the existing portion of a path so a symlink inside an authorized root cannot escape
// that root. Writes may target a new file, so walk up to the nearest existing parent first.
const resolvePhysicalPath = async (candidatePath: string): Promise<string> => {
  try {
    return await realpath(candidatePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A dangling symlink is an existing path whose target is missing. Do not treat it as a new
    // file: writeFile would follow the link if its target appeared later, escaping the authorized
    // root. A genuinely missing path still falls through to its nearest existing parent.
    try {
      const stats = await lstat(candidatePath)
      if (stats.isSymbolicLink()) {
        throw new Error(`Cannot authorize a dangling symbolic link: ${candidatePath}`)
      }
    } catch (lstatError) {
      if ((lstatError as NodeJS.ErrnoException).code !== 'ENOENT') throw lstatError
    }
    const parent = dirname(candidatePath)
    if (parent === candidatePath) return resolve(candidatePath)
    const physicalParent = await resolvePhysicalPath(parent)
    return resolve(physicalParent, candidatePath.slice(parent.length + 1))
  }
}

const assertAuthorizedPath = async (
  workspaceRoot: string,
  candidatePath: string,
  grantedRoots: readonly GrantedRoot[],
  requiredAccess: GrantedLocalRoot['access']
): Promise<{ path: string; physicalPath: string }> => {
  const path = resolve(candidatePath)
  const physicalPath = await resolvePhysicalPath(path)
  const physicalWorkspaceRoot = await resolvePhysicalPath(resolve(workspaceRoot))

  if (isPathInsideWorkspace(physicalWorkspaceRoot, physicalPath)) {
    return { path, physicalPath }
  }

  for (const root of grantedRoots) {
    if (requiredAccess === 'rw' && root.access !== 'rw') continue
    let physicalRoot: string
    try {
      physicalRoot = await resolvePhysicalPath(resolve(root.path))
    } catch {
      continue
    }
    if (isPathInsideWorkspace(physicalRoot, physicalPath)) {
      return { path, physicalPath }
    }
  }

  throw new Error(`Path is outside the active ACP workspace: ${candidatePath}`)
}

// Scan only through the requested window. String decoding handles UTF-8 split across chunks;
// split on LF explicitly so a bare CR retains the existing text-file semantics.
const readLineWindow = async (
  file: FileHandle,
  filePath: string,
  line?: number | null,
  limit?: number | null
): Promise<string> => {
  const startIndex = Math.max((line ?? 1) - 1, 0)
  const endIndex = limit ? startIndex + Math.max(limit, 0) : Infinity
  const selected: string[] = []
  let index = 0
  let pending = ''
  let scanned = 0
  const stream = createReadStream(filePath, {
    fd: file.fd,
    autoClose: false,
    encoding: 'utf8',
    highWaterMark: 16 * 1024
  })
  try {
    for await (const chunk of stream) {
      pending += chunk
      let newline: number
      while ((newline = pending.indexOf('\n', scanned)) !== -1) {
        if (index >= startIndex && index < endIndex) {
          const text = pending.slice(0, newline)
          selected.push(text.endsWith('\r') ? text.slice(0, -1) : text)
        }
        index += 1
        if (index >= endIndex) return selected.join('\n')
        pending = pending.slice(newline + 1)
        scanned = 0
      }
      scanned = pending.length
    }
    // split(/\r?\n/) includes the final empty line when the file ends with LF.
    if (index >= startIndex && index < endIndex) selected.push(pending)
    return selected.join('\n')
  } finally {
    if (!stream.destroyed) stream.destroy()
    if (!stream.closed) await new Promise<void>((resolve) => stream.once('close', resolve))
  }
}

// Rejects reads that resolve inside an app-owned protected directory — e.g. the CLAUDE_CONFIG_DIR
// that holds materialized skill files — so bundled skill contents can never be surfaced verbatim
// through the Read tool. (Workspace containment already blocks most of these; this is belt-and-
// suspenders for sessions whose cwd is unusually broad.)
const assertNotProtected = async (filePath: string, protectedRoots: string[]): Promise<void> => {
  for (const root of protectedRoots) {
    let physicalRoot: string
    try {
      physicalRoot = await resolvePhysicalPath(resolve(root))
    } catch {
      // Keep lexical protection for a root that does not exist yet. A future file created there
      // must not become readable merely because canonicalization was unavailable at this moment.
      physicalRoot = resolve(root)
    }
    if (isPathInsideWorkspace(physicalRoot, filePath)) {
      throw new Error('This file belongs to a protected application directory and cannot be read.')
    }
  }
}

const closeFile = async (file: FileHandle): Promise<void> => {
  await file.close().catch(() => undefined)
}

// Open the canonical path before using it, then re-resolve the opened path. The handle keeps the
// file identity stable after this check; O_NOFOLLOW rejects a final symlink on POSIX, while the
// re-resolution also covers platforms whose Node runtime ignores that flag. Node does not provide
// portable directory-descriptor opening on Windows, so the parent-handle check is POSIX-only.
const openAuthorizedFile = async (
  physicalPath: string,
  flags: number,
  mode?: number
): Promise<FileHandle> => {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const parent =
    process.platform === 'win32'
      ? undefined
      : await open(
          dirname(physicalPath),
          constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollow
        )
  try {
    const parentIdentity = parent ? await parent.stat() : undefined
    const file = await open(physicalPath, flags | noFollow, mode)
    try {
      const currentParent = parent ? await parent.stat() : undefined
      if (
        (parent && parentIdentity && currentParent
          ? currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino
          : false) ||
        (await resolvePhysicalPath(physicalPath)) !== physicalPath
      ) {
        throw new Error('The authorized file path changed before I/O.')
      }
      return file
    } catch (error) {
      await closeFile(file)
      throw error
    }
  } finally {
    if (parent) await closeFile(parent)
  }
}

// Reads a text file after constraining the requested path to the active workspace and rejecting
// app-owned protected directories.
const readWorkspaceTextFile = async (
  workspaceRoot: string,
  params: ReadTextFileRequest,
  protectedRoots: string[] = [],
  grantedRoots: readonly GrantedRoot[] = []
): Promise<ReadTextFileResponse> => {
  // ACP paths are absolute, but resolve again here so path traversal is checked in one place.
  const { path: filePath, physicalPath } = await assertAuthorizedPath(
    workspaceRoot,
    params.path,
    grantedRoots,
    'ro'
  )
  await assertNotProtected(physicalPath, protectedRoots)
  const file = await openAuthorizedFile(physicalPath, constants.O_RDONLY)
  try {
    return {
      content:
        !params.line && !params.limit
          ? await file.readFile('utf8')
          : await readLineWindow(file, filePath, params.line, params.limit)
    }
  } finally {
    await closeFile(file)
  }
}

// Writes a text file after creating parent directories inside the active workspace.
const writeWorkspaceTextFile = async (
  workspaceRoot: string,
  params: WriteTextFileRequest,
  grantedRoots: readonly GrantedRoot[] = []
): Promise<WriteTextFileResponse> => {
  const authorized = await assertAuthorizedPath(workspaceRoot, params.path, grantedRoots, 'rw')

  await mkdir(dirname(authorized.physicalPath), { recursive: true })
  const reopened = await assertAuthorizedPath(workspaceRoot, params.path, grantedRoots, 'rw')
  const existing = await lstat(reopened.physicalPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing?.isSymbolicLink()) {
    throw new Error(`Cannot authorize a symbolic link: ${params.path}`)
  }
  const flags = constants.O_WRONLY | (existing ? 0 : constants.O_CREAT | constants.O_EXCL)
  const file = await openAuthorizedFile(reopened.physicalPath, flags, 0o666)
  try {
    await file.truncate(0)
    await file.writeFile(params.content, 'utf8')
  } finally {
    await closeFile(file)
  }

  return {}
}

export { readWorkspaceTextFile, writeWorkspaceTextFile }
