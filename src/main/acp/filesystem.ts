import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse
} from '@agentclientprotocol/sdk'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { assertWorkspacePath } from './workspace-path'

// Returns the requested line window while preserving full content by default.
const sliceLines = (content: string, line?: number | null, limit?: number | null): string => {
  if (!line && !limit) {
    return content
  }

  const lines = content.split(/\r?\n/)
  const startIndex = Math.max((line ?? 1) - 1, 0)
  const endIndex = limit ? startIndex + Math.max(limit, 0) : undefined

  return lines.slice(startIndex, endIndex).join('\n')
}

// Reads a text file after constraining the requested path to the active workspace.
const readWorkspaceTextFile = async (
  workspaceRoot: string,
  params: ReadTextFileRequest
): Promise<ReadTextFileResponse> => {
  // ACP paths are absolute, but resolve again here so path traversal is checked in one place.
  const filePath = assertWorkspacePath(workspaceRoot, params.path)
  const content = await readFile(filePath, 'utf8')

  return {
    content: sliceLines(content, params.line, params.limit)
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
