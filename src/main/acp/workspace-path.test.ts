import { describe, expect, it } from 'vitest'

import { assertWorkspacePath, isPathInsideWorkspace } from './workspace-path'

describe('workspace path guard', () => {
  it('allows the workspace root and descendants', () => {
    const workspaceRoot = '/tmp/open-science'

    expect(isPathInsideWorkspace(workspaceRoot, workspaceRoot)).toBe(true)
    expect(isPathInsideWorkspace(workspaceRoot, '/tmp/open-science/src/main/index.ts')).toBe(true)
  })

  it('rejects sibling paths that only share the same prefix', () => {
    expect(isPathInsideWorkspace('/tmp/open-science', '/tmp/open-science-backup/notes.txt')).toBe(
      false
    )
  })

  it('throws a clear error for paths outside the workspace', () => {
    expect(() => assertWorkspacePath('/tmp/open-science', '/tmp/elsewhere/file.txt')).toThrow(
      /outside the active ACP workspace/
    )
  })
})
