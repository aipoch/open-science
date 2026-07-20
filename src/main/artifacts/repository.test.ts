import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import type { ArtifactWriteSource } from '../../shared/artifacts'
import { ArtifactRepository, getProjectArtifactDir } from './repository'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifacts-'))
  return storageRoot
}

const createInlineSource = (
  content: string,
  encoding: 'utf8' | 'base64' = 'utf8'
): ArtifactWriteSource => ({
  kind: 'inline' as const,
  content,
  encoding
})

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('artifact repository', () => {
  it('writes pending artifact files under the project and session run directory', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'report.xml',
      mimeType: 'application/xml',
      source: createInlineSource('<report />')
    })

    expect(artifact).toMatchObject({
      id: 'session-1:run-1:report.xml',
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      name: 'report.xml',
      mimeType: 'application/xml',
      size: '<report />'.length
    })
    expect(artifact.path).toBe(
      join(root, 'artifacts', 'default-project', 'session-1', '.pending', 'run-1', 'report.xml')
    )
    expect(artifact.fileUrl).toMatch(/^file:\/\//)
    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('<report />')
  })

  it('writes large inline base64 artifacts without repository size limits', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)
    const content = Buffer.alloc(4 * 1024 * 1024, 7).toString('base64')

    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'large.bin',
      source: { kind: 'inline', content, encoding: 'base64' }
    })

    expect(artifact.size).toBe(4 * 1024 * 1024)
  })

  it('copies a local source file from an allowed root into pending artifacts', async () => {
    const root = await createStorageRoot()
    const allowedRoot = join(root, 'notebook-session')
    const sourcePath = join(allowedRoot, 'plot.png')
    await mkdir(allowedRoot, { recursive: true })
    await writeFile(sourcePath, Buffer.from([1, 2, 3]))

    const repository = new ArtifactRepository(root)
    const artifact = await repository.writePendingFile(
      {
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'plot.png',
        mimeType: 'image/png',
        source: { kind: 'localPath', path: sourcePath }
      },
      { allowedImportRoots: [allowedRoot] }
    )

    await expect(readFile(artifact.path)).resolves.toEqual(Buffer.from([1, 2, 3]))
    await expect(readFile(sourcePath)).resolves.toEqual(Buffer.from([1, 2, 3]))
  })

  it('rejects local source files outside allowed import roots', async () => {
    const root = await createStorageRoot()
    const allowedRoot = join(root, 'notebook-session')
    const sourcePath = join(root, 'outside.txt')
    await writeFile(sourcePath, 'nope', 'utf8')

    const repository = new ArtifactRepository(root)

    const attempt = repository.writePendingFile(
      {
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'outside.txt',
        source: { kind: 'localPath', path: sourcePath }
      },
      { allowedImportRoots: [allowedRoot] }
    )
    await expect(attempt).rejects.toThrow(/outside allowed artifact import roots/)
    // The rejection is actionable: it names the offending path and the allowed root so the agent can
    // re-save inside the sandbox instead of retrying blindly.
    await expect(attempt).rejects.toThrow(sourcePath)
    await expect(attempt).rejects.toThrow(allowedRoot)
  })

  it('rejects a non-existent local source file with a save-first message', async () => {
    // The agent's common mistake is calling write_artifact_file before the file is saved (e.g. after
    // plt.show() with no savefig). The rejection tells it to save the file first, not a raw ENOENT.
    const root = await createStorageRoot()
    const allowedRoot = join(root, 'notebook-session')
    const missingPath = join(allowedRoot, 'never-saved.png')

    const repository = new ArtifactRepository(root)

    const attempt = repository.writePendingFile(
      {
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'never-saved.png',
        source: { kind: 'localPath', path: missingPath }
      },
      { allowedImportRoots: [allowedRoot] }
    )
    await expect(attempt).rejects.toThrow(/does not exist/)
    await expect(attempt).rejects.toThrow(/before calling write_artifact_file/)
  })

  it('rejects path-like project, session, run, and filename segments', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())

    await expect(
      repository.writePendingFile({
        projectName: '../default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'report.xml',
        source: createInlineSource('<report />')
      })
    ).rejects.toThrow(/Invalid artifact path segment/)
    await expect(
      repository.writePendingFile({
        projectName: 'default-project',
        sessionId: 'session/1',
        runId: 'run-1',
        filename: 'report.xml',
        source: createInlineSource('<report />')
      })
    ).rejects.toThrow(/Invalid artifact path segment/)
    await expect(
      repository.writePendingFile({
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: '../report.xml',
        source: createInlineSource('<report />')
      })
    ).rejects.toThrow(/Invalid artifact filename/)
    await expect(
      repository.writePendingFile({
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'nested\\report.xml',
        source: createInlineSource('<report />')
      })
    ).rejects.toThrow(/Invalid artifact filename/)
    await expect(
      repository.writePendingFile({
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'report:1.xml',
        source: createInlineSource('<report />')
      })
    ).rejects.toThrow(/Invalid artifact filename/)
    await expect(
      repository.writePendingFile({
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'report\n.xml',
        source: createInlineSource('<report />')
      })
    ).rejects.toThrow(/Invalid artifact filename/)
  })

  it('finalizes a pending run by moving files into the message directory', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'report.xml',
      mimeType: 'application/xml',
      source: createInlineSource('<report />')
    })

    const files = await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      id: 'session-1:message-1:report.xml',
      projectName: 'default-project',
      sessionId: 'session-1',
      messageId: 'message-1',
      name: 'report.xml',
      mimeType: 'application/xml'
    })
    expect(files[0].path).toBe(
      join(root, 'artifacts', 'default-project', 'session-1', 'message-1', 'report.xml')
    )
    await expect(readFile(files[0].path, 'utf8')).resolves.toBe('<report />')
    await expect(
      readdir(join(root, 'artifacts', 'default-project', 'session-1', '.pending'))
    ).resolves.not.toContain('run-1')
  })

  it('recovers a finalized file when a preview still references its old pending path', async () => {
    // Root cause of the transient "Failed to read artifact preview ENOENT": the renderer keeps the
    // `.pending/<run>/` path while finalizeRunArtifacts moves the file into the message directory.
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'plot.png',
      source: createInlineSource('img-bytes')
    })
    const pendingPath = join(
      root,
      'artifacts',
      'default-project',
      'session-1',
      '.pending',
      'run-1',
      'plot.png'
    )

    await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-7'
    })

    // The pending path is gone, but resolving/previewing it recovers the finalized copy.
    const resolved = await repository.resolveManagedFilePath({ path: pendingPath })
    const expected = await realpath(
      join(root, 'artifacts', 'default-project', 'session-1', 'message-7', 'plot.png')
    )
    expect(resolved).toBe(expected)

    const preview = await repository.readManagedFilePreview({ path: pendingPath })
    expect(preview.content).toContain('img-bytes')
  })

  it('recovers a same-named pending file to its own run, not the newest same-named file', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    // Two runs in one session each produce report.csv, finalized into different messages. The second
    // finalize is newer, so a newest-mtime recovery would wrongly resolve run A's path to run B's file.
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-a',
      filename: 'report.csv',
      source: createInlineSource('run-a-content')
    })
    await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-a',
      messageId: 'message-a'
    })
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-b',
      filename: 'report.csv',
      source: createInlineSource('run-b-content')
    })
    await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-b',
      messageId: 'message-b'
    })

    const pendingPathA = join(
      root,
      'artifacts',
      'default-project',
      'session-1',
      '.pending',
      'run-a',
      'report.csv'
    )
    const resolved = await repository.resolveManagedFilePath({ path: pendingPathA })
    expect(resolved).toBe(
      await realpath(
        join(root, 'artifacts', 'default-project', 'session-1', 'message-a', 'report.csv')
      )
    )
    const preview = await repository.readManagedFilePreview({ path: pendingPathA })
    expect(preview.content).toContain('run-a-content')
  })

  it('falls back to a newest-mtime scan when no run marker exists (legacy artifacts)', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'legacy.txt',
      source: createInlineSource('legacy')
    })
    await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })
    // Remove the run marker to simulate an artifact finalized before markers existed.
    await rm(join(root, 'artifacts', 'default-project', 'session-1', '.runs'), {
      recursive: true,
      force: true
    })

    const pendingPath = join(
      root,
      'artifacts',
      'default-project',
      'session-1',
      '.pending',
      'run-1',
      'legacy.txt'
    )
    const resolved = await repository.resolveManagedFilePath({ path: pendingPath })
    expect(resolved).toBe(
      await realpath(
        join(root, 'artifacts', 'default-project', 'session-1', 'message-1', 'legacy.txt')
      )
    )
  })

  it('still throws for a missing artifact path that was never finalized', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)
    const missing = join(
      root,
      'artifacts',
      'default-project',
      'session-1',
      '.pending',
      'run-1',
      'nope.png'
    )
    await expect(repository.resolveManagedFilePath({ path: missing })).rejects.toThrow()
  })

  it('finalizes pending files from an internal artifact session scope', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'report.xml',
      source: createInlineSource('<report />')
    })

    const files = await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sourceSessionId: 'artifact-session-1',
      sessionId: 'real-session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    expect(files[0]).toMatchObject({
      id: 'real-session-1:message-1:report.xml',
      sessionId: 'real-session-1',
      messageId: 'message-1',
      name: 'report.xml'
    })
    expect(files[0].path).toBe(
      join(root, 'artifacts', 'default-project', 'real-session-1', 'message-1', 'report.xml')
    )
    await expect(readFile(files[0].path, 'utf8')).resolves.toBe('<report />')
  })

  it('returns existing message files when a finalized run is replayed', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'report.xml',
      source: createInlineSource('<report />')
    })
    await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    const files = await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    expect(files.map((file) => file.name)).toEqual(['report.xml'])
    expect(files[0]).toMatchObject({
      sessionId: 'session-1',
      messageId: 'message-1'
    })
  })

  it('recovers when some pending files were already moved into the message directory', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)
    const pendingDir = join(root, 'artifacts', 'default-project', 'session-1', '.pending', 'run-1')
    const messageDir = join(root, 'artifacts', 'default-project', 'session-1', 'message-1')

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'alpha.txt',
      source: createInlineSource('a')
    })
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'zeta.txt',
      source: createInlineSource('z')
    })
    await mkdir(messageDir, { recursive: true })
    await rename(join(pendingDir, 'alpha.txt'), join(messageDir, 'alpha.txt'))

    const files = await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    expect(files.map((file) => file.name)).toEqual(['alpha.txt', 'zeta.txt'])
    await expect(readFile(join(messageDir, 'alpha.txt'), 'utf8')).resolves.toBe('a')
    await expect(readFile(join(messageDir, 'zeta.txt'), 'utf8')).resolves.toBe('z')
  })

  it('recovers metadata for files already moved into the message directory', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)
    const pendingDir = join(root, 'artifacts', 'default-project', 'session-1', '.pending', 'run-1')
    const messageDir = join(root, 'artifacts', 'default-project', 'session-1', 'message-1')

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'alpha.svg',
      mimeType: 'image/svg+xml',
      source: createInlineSource('<svg />')
    })
    await mkdir(messageDir, { recursive: true })
    await rename(join(pendingDir, 'alpha.svg'), join(messageDir, 'alpha.svg'))

    const files = await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    expect(files).toEqual([
      expect.objectContaining({
        name: 'alpha.svg',
        mimeType: 'image/svg+xml'
      })
    ])
  })

  it('lists pending run files before the renderer chooses a message owner', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'zeta.txt',
      source: createInlineSource('z')
    })
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'alpha.txt',
      source: createInlineSource('a')
    })

    const files = await repository.listPendingRunFiles({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1'
    })

    expect(files.map((file) => file.name)).toEqual(['alpha.txt', 'zeta.txt'])
    expect(files[0]).toMatchObject({
      id: 'session-1:run-1:alpha.txt',
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      name: 'alpha.txt'
    })
  })

  it('lists finalized message files in stable filename order', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'zeta.txt',
      source: createInlineSource('z')
    })
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'alpha.txt',
      source: createInlineSource('a')
    })
    await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    const files = await repository.listMessageFiles({
      projectName: 'default-project',
      sessionId: 'session-1',
      messageId: 'message-1'
    })

    expect(files.map((file) => file.name)).toEqual(['alpha.txt', 'zeta.txt'])
  })

  it('lists finalized artifacts across all sessions and excludes pending files', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    // Two sessions each finalize a file into a message directory.
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'alpha.txt',
      source: createInlineSource('a')
    })
    await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-2',
      runId: 'run-2',
      filename: 'beta.txt',
      source: createInlineSource('b')
    })
    await repository.finalizeRunArtifacts({
      projectName: 'default-project',
      sessionId: 'session-2',
      runId: 'run-2',
      messageId: 'message-2'
    })
    // A never-finalized pending file must not be listed as a project artifact.
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-3',
      filename: 'draft.txt',
      source: createInlineSource('d')
    })

    const files = await repository.listProjectArtifacts('default-project')

    expect(files.map((file) => file.name).sort()).toEqual(['alpha.txt', 'beta.txt'])
    expect(files.map((file) => file.sessionId).sort()).toEqual(['session-1', 'session-2'])
  })

  it('returns an empty list when a project has no artifacts on disk', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    await expect(repository.listProjectArtifacts('default-project')).resolves.toEqual([])
  })

  it('reconciles a crash-orphaned pending artifact into its message directory', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    // Simulate the crash window: a pending file was written and its path persisted, but finalize never
    // ran (no run-registry claim survives a restart).
    const pending = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-7',
      filename: 'chart.png',
      mimeType: 'image/png',
      source: createInlineSource('png')
    })
    expect(pending.path).toContain('.pending')

    const finalized = await repository.reconcilePendingArtifactPaths({
      projectName: 'default-project',
      sessionId: 'app-session-1',
      messageId: 'message-9',
      pendingPaths: [pending.path]
    })

    expect(finalized.map((file) => file.name)).toEqual(['chart.png'])
    expect(finalized[0].path).toBe(
      join(root, 'artifacts', 'default-project', 'app-session-1', 'message-9', 'chart.png')
    )
    await expect(readFile(finalized[0].path, 'utf8')).resolves.toBe('png')

    // Idempotent: replaying the reconcile (e.g. a second startup) returns the same finalized file.
    const replayed = await repository.reconcilePendingArtifactPaths({
      projectName: 'default-project',
      sessionId: 'app-session-1',
      messageId: 'message-9',
      pendingPaths: [pending.path]
    })
    expect(replayed.map((file) => file.name)).toEqual(['chart.png'])
  })

  it('ignores non-pending paths during reconciliation instead of moving unrelated files', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    const finalized = await repository.reconcilePendingArtifactPaths({
      projectName: 'default-project',
      sessionId: 'app-session-1',
      messageId: 'message-1',
      pendingPaths: [
        join(root, 'artifacts', 'default-project', 'app-session-1', 'message-1', 'x.txt')
      ]
    })

    expect(finalized).toEqual([])
  })

  it('derives the project artifact directory from the app storage root', () => {
    // Build the expectation with join() so the separator matches the host the test runs on.
    expect(getProjectArtifactDir('/Users/example/.open-science', 'default-project')).toBe(
      join('/Users/example/.open-science', 'artifacts', 'default-project')
    )
  })
})
