import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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

  it('deletes every Session workspace owned by one Project without touching another Project', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-project-workspace-'))
    const input = join(root, 'input.csv')
    await writeFile(input, 'value\n1\n')
    const workspaceRoot = join(root, 'workspaces')
    const workspace = createProductionFrameWorkspace({
      root: workspaceRoot,
      resolveInput: async () => ({ path: input })
    })
    const first = await workspace.prepare(
      { projectId: 'project-1', sessionId: 'session-1' },
      'frame-1',
      ['upload-version:upload-1']
    )
    const second = await workspace.prepare(
      { projectId: 'project-1', sessionId: 'session-2' },
      'frame-2',
      ['upload-version:upload-1']
    )
    const other = await workspace.prepare(
      { projectId: 'project-2', sessionId: 'session-3' },
      'frame-3',
      ['upload-version:upload-1']
    )

    try {
      await workspace.deleteProject('project-1')

      await expect(stat(join(workspaceRoot, 'project-1'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(first.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(second.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(other.cwd)).resolves.toBeDefined()
    } finally {
      // Prepared inputs are read-only. Restore their permissions through the production cleanup
      // boundary so the shared temporary-root teardown is portable to macOS.
      await workspace.deleteProject('project-2')
    }
  })

  it.runIf(process.platform !== 'win32')(
    'does not follow workspace symlinks while restoring delete permissions',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'delegated-project-workspace-symlink-'))
      const workspaceRoot = join(root, 'workspaces')
      const externalRoot = join(root, 'external-owned')
      const externalFile = join(externalRoot, 'protected.txt')
      await mkdir(join(workspaceRoot, 'project-1'), { recursive: true })
      await mkdir(externalRoot)
      await writeFile(externalFile, 'keep permissions')
      await chmod(externalRoot, 0o500)
      await chmod(externalFile, 0o400)
      await symlink(externalRoot, join(workspaceRoot, 'project-1', 'external-link'), 'dir')
      const workspace = createProductionFrameWorkspace({
        root: workspaceRoot,
        resolveInput: async () => ({ path: externalFile })
      })

      try {
        await workspace.deleteProject('project-1')

        expect((await stat(externalRoot)).mode & 0o777).toBe(0o500)
        expect((await stat(externalFile)).mode & 0o777).toBe(0o400)
        await expect(readFile(externalFile, 'utf8')).resolves.toBe('keep permissions')
      } finally {
        await chmod(externalRoot, 0o700)
        await chmod(externalFile, 0o600)
      }
    }
  )
})

describe('reported workspace lease regression', () => {
  it.each(['before failure', 'after failure'] as const)(
    'D02 closes a lease resolved %s when another input fails',
    async (timing) => {
      root = await mkdtemp(join(tmpdir(), 'delegated-workspace-lease-'))
      const input = join(root, 'input.csv')
      await writeFile(input, 'value\n1\n')
      const close = vi.fn(async () => undefined)
      let release!: () => void
      const delayed = new Promise<void>((resolve) => {
        release = resolve
      })
      let rejected!: () => void
      const rejection = new Promise<void>((resolve) => {
        rejected = resolve
      })
      const workspace = createProductionFrameWorkspace({
        root: join(root, 'workspaces'),
        async resolveInput(identity) {
          if (identity === 'upload-version:broken') {
            rejected()
            throw new Error('input resolution failed')
          }
          if (timing === 'after failure') await delayed
          return { path: input, close }
        }
      })
      const preparation = workspace
        .prepare({ projectId: 'project-1', sessionId: 'session-1' }, 'frame-1', [
          'upload-version:valid',
          'upload-version:broken'
        ])
        .then(
          (value) => ({ value }),
          (error) => ({ error })
        )
      await rejection
      // Drain the immediate rejection before allowing the other resolver to finish.
      await new Promise<void>((resolve) => setImmediate(resolve))
      release()
      expect(await preparation).toMatchObject({ error: { message: 'input resolution failed' } })
      expect(close).toHaveBeenCalledOnce()
    }
  )

  it('D02 closes every resolved lease exactly once when copying fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-workspace-copy-'))
    const closes = [vi.fn(async () => undefined), vi.fn(async () => undefined)]
    const workspace = createProductionFrameWorkspace({
      root: join(root, 'workspaces'),
      async resolveInput(identity) {
        return {
          path: join(root!, 'input.csv'),
          close: closes[identity === 'upload-version:first' ? 0 : 1],
          copyTo: async () => {
            throw new Error('copy failed')
          }
        }
      }
    })
    await expect(
      workspace.prepare({ projectId: 'project-1', sessionId: 'session-1' }, 'frame-1', [
        'upload-version:first',
        'upload-version:second'
      ])
    ).rejects.toThrow('copy failed')
    for (const close of closes) expect(close).toHaveBeenCalledOnce()
  })
})
