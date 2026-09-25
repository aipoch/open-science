import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse
} from '@agentclientprotocol/sdk'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
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
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 16 * 1024 })
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
  return {
    content:
      !params.line && !params.limit
        ? await readFile(filePath, 'utf8')
        : await readLineWindow(filePath, params.line, params.limit)
  }
}

// Writes a text file after creating parent directories inside the active workspace.
const writeWorkspaceTextFile = async (
  workspaceRoot: string,
  params: WriteTextFileRequest,
  grantedRoots: readonly GrantedRoot[] = []
): Promise<WriteTextFileResponse> => {
  const { path: filePath } = await assertAuthorizedPath(
    workspaceRoot,
    params.path,
    grantedRoots,
    'rw'
  )

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, params.content, 'utf8')

  return {}
}

export { readWorkspaceTextFile, writeWorkspaceTextFile }
