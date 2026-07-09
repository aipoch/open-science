import { isAbsolute, relative, resolve } from 'node:path'

// Checks whether a resolved candidate path remains under the workspace root.
const isPathInsideWorkspace = (workspaceRoot: string, candidatePath: string): boolean => {
  const resolvedRoot = resolve(workspaceRoot)
  const resolvedCandidate = resolve(candidatePath)
  const relativePath = relative(resolvedRoot, resolvedCandidate)

  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

// Returns a safe absolute path or rejects access outside the workspace root.
const assertWorkspacePath = (workspaceRoot: string, candidatePath: string): string => {
  const resolvedCandidate = resolve(candidatePath)

  if (!isPathInsideWorkspace(workspaceRoot, resolvedCandidate)) {
    throw new Error(`Path is outside the active ACP workspace: ${candidatePath}`)
  }

  return resolvedCandidate
}

export { assertWorkspacePath, isPathInsideWorkspace }
