import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse
} from '@agentclientprotocol/sdk'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { assertWorkspacePath, isPathInsideWorkspace } from './workspace-path'

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
const assertNotProtected = (filePath: string, protectedRoots: string[]): void => {
  for (const root of protectedRoots) {
    if (isPathInsideWorkspace(root, filePath)) {
      throw new Error('This file belongs to a protected application directory and cannot be read.')
    }
  }
}

// Reads a text file after constraining the requested path to the active workspace and rejecting
// app-owned protected directories.
const readWorkspaceTextFile = async (
  workspaceRoot: string,
  params: ReadTextFileRequest,
  protectedRoots: string[] = []
): Promise<ReadTextFileResponse> => {
  // ACP paths are absolute, but resolve again here so path traversal is checked in one place.
  const filePath = assertWorkspacePath(workspaceRoot, params.path)
  assertNotProtected(filePath, protectedRoots)
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
  params: WriteTextFileRequest
): Promise<WriteTextFileResponse> => {
  const filePath = assertWorkspacePath(workspaceRoot, params.path)

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, params.content, 'utf8')

  return {}
}

export { readWorkspaceTextFile, writeWorkspaceTextFile }
