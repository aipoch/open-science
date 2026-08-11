import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProductionFrameWorkspace } from './frame-workspace'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('production delegated Frame workspace', () => {
  it('validates immutable Version identities and stages read-only bytes in a stable Frame cwd', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-frame-workspace-'))
    const upload = join(root, 'upload.csv')
    const artifact = join(root, 'artifact.md')
    await writeFile(upload, 'a,b\n1,2\n')
    await writeFile(artifact, '# evidence\n')
    const resolveInput = vi.fn(async (identity: string) => {
      if (identity === 'upload-version:upload-1') return { path: upload, filename: 'data.csv' }
      if (identity === 'artifact-version:project-1/session-1/a/v') {
        return { path: artifact, filename: 'report.md' }
      }
      throw new Error('not an immutable Version')
    })
    const workspace = createProductionFrameWorkspace({
      root: join(root, 'workspaces'),
      resolveInput
    })
    const session = { projectId: 'project-1', sessionId: 'session-1' }

    await expect(workspace.validateInput('mutable/current.csv', session)).resolves.toBe(false)
    await expect(workspace.validateInput('upload-version:upload-1', session)).resolves.toBe(true)
    const first = await workspace.prepare(session, 'frame-1', [
      'upload-version:upload-1',
      'artifact-version:project-1/session-1/a/v'
    ])
    const second = await workspace.prepare(session, 'frame-1', [
      'upload-version:upload-1',
      'artifact-version:project-1/session-1/a/v'
    ])

    expect(second.cwd).toBe(first.cwd)
    await expect(readFile(join(first.cwd, 'inputs', '01-data.csv'), 'utf8')).resolves.toBe(
      'a,b\n1,2\n'
    )
    await expect(readFile(join(first.cwd, 'inputs', '02-report.md'), 'utf8')).resolves.toBe(
      '# evidence\n'
    )
    expect((await stat(join(first.cwd, 'inputs', '01-data.csv'))).mode & 0o222).toBe(0)
    expect((await stat(join(first.cwd, 'inputs', '02-report.md'))).mode & 0o222).toBe(0)
    await workspace.deleteSession(session)
  })
})
