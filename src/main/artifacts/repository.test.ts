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
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import type { ArtifactWriteSource } from '../../shared/artifacts'
import {
  ArtifactRepository,
  getArtifactCurrentRunFilePath,
  getProjectArtifactDir
} from './repository'

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

  it('resolves a relative local source path against the notebook data dir base', async () => {
    // The agent saves with a relative name (plt.savefig("plot.png")) inside the kernel cwd; passing
    // that bare name must resolve against the data dir, not the MCP process cwd.
    const root = await createStorageRoot()
    const dataDir = join(root, 'notebook-session', 'data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'plot.png'), Buffer.from([9, 8, 7]))

    const repository = new ArtifactRepository(root)
    const artifact = await repository.writePendingFile(
      {
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'plot.png',
        source: { kind: 'localPath', path: 'plot.png' }
      },
      { allowedImportRoots: [dataDir], relativeBaseDirs: [dataDir] }
    )

    await expect(readFile(artifact.path)).resolves.toEqual(Buffer.from([9, 8, 7]))
  })

  it('still honors an absolute local source path when a relative base is set', async () => {
    // path.resolve drops the base for an absolute path, so an explicit absolute path keeps working.
    const root = await createStorageRoot()
    const dataDir = join(root, 'notebook-session', 'data')
    const sourcePath = join(dataDir, 'chart.png')
    await mkdir(dataDir, { recursive: true })
    await writeFile(sourcePath, Buffer.from([4, 5, 6]))

    const repository = new ArtifactRepository(root)
    const artifact = await repository.writePendingFile(
      {
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'chart.png',
        source: { kind: 'localPath', path: sourcePath }
      },
      { allowedImportRoots: [dataDir], relativeBaseDirs: [dataDir] }
    )

    await expect(readFile(artifact.path)).resolves.toEqual(Buffer.from([4, 5, 6]))
  })

  it('falls back to the next relative base dir when the file is not under the first', async () => {
    // A plain-chat turn inside a notebook-capable runtime: the base list leads with the notebook
    // data dir (no kernel ran, so nothing is there) and the session workspace second; the file the
    // agent saved with plain shell tools must still resolve.
    const root = await createStorageRoot()
    const dataDir = join(root, 'notebook-session', 'data')
    const workspace = join(root, 'workspace')
    await mkdir(dataDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'plot.png'), Buffer.from([1, 1, 1]))

    const repository = new ArtifactRepository(root)
    const artifact = await repository.writePendingFile(
      {
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'plot.png',
        source: { kind: 'localPath', path: 'plot.png' }
      },
      { allowedImportRoots: [dataDir, workspace], relativeBaseDirs: [dataDir, workspace] }
    )

    await expect(readFile(artifact.path)).resolves.toEqual(Buffer.from([1, 1, 1]))
  })

  it('prefers the first relative base dir when the file exists under several', async () => {
    // The notebook data dir leads the base list, so a same-named file the agent left in the session
    // workspace must not shadow the kernel output of the current turn.
    const root = await createStorageRoot()
    const dataDir = join(root, 'notebook-session', 'data')
    const workspace = join(root, 'workspace')
    await mkdir(dataDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(join(dataDir, 'plot.png'), Buffer.from([9, 9, 9]))
    await writeFile(join(workspace, 'plot.png'), Buffer.from([2, 2, 2]))

    const repository = new ArtifactRepository(root)
    const artifact = await repository.writePendingFile(
      {
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'plot.png',
        source: { kind: 'localPath', path: 'plot.png' }
      },
      { allowedImportRoots: [dataDir, workspace], relativeBaseDirs: [dataDir, workspace] }
    )

    await expect(readFile(artifact.path)).resolves.toEqual(Buffer.from([9, 9, 9]))
  })

  it('rejects a relative local source path when no relative base dir is set', async () => {
    // Without a notebook data dir there is no base to resolve against; falling back to the process
    // cwd (the app process for the in-process HTTP MCP host) reports "does not exist" even when the
    // file sits inside an allowed root. Reject up front and demand an absolute path instead.
    const root = await createStorageRoot()
    const allowedRoot = join(root, 'workspace')
    await mkdir(allowedRoot, { recursive: true })
    await writeFile(join(allowedRoot, 'plot.png'), Buffer.from([1, 2, 3]))

    const repository = new ArtifactRepository(root)

    const attempt = repository.writePendingFile(
      {
        projectName: 'default-project',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'plot.png',
        source: { kind: 'localPath', path: 'plot.png' }
      },
      { allowedImportRoots: [allowedRoot] }
    )
    await expect(attempt).rejects.toThrow(/does not exist/)
    await expect(attempt).rejects.toThrow(/absolute path/i)
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

  it('never falls back to another run when a marker exists but its target file is gone', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    // Same two-run setup, but run A's finalized file is deleted afterward (e.g. by the user). A marker
    // for run A still exists, so recovery must NOT fall back to run B's same-named file — the artifact
    // is simply gone.
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

    await rm(join(root, 'artifacts', 'default-project', 'session-1', 'message-a', 'report.csv'))

    const pendingPathA = join(
      root,
      'artifacts',
      'default-project',
      'session-1',
      '.pending',
      'run-a',
      'report.csv'
    )
    await expect(repository.resolveManagedFilePath({ path: pendingPathA })).rejects.toThrow()
  })

  it('does NOT recover an unmarked stale pending path (absent marker == failed write, unsafe to guess)', async () => {
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
    // Remove the run marker: an absent marker (legacy artifact OR a failed best-effort write) is
    // indistinguishable, so recovery must not guess even though the finalized file exists.
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
    await expect(repository.resolveManagedFilePath({ path: pendingPath })).rejects.toThrow()
  })

  it('does NOT recover an unmarked path when multiple same-named candidates exist', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    // Two runs both produced report.csv into different messages, then BOTH markers were lost (e.g. the
    // marker writes failed). Recovery must not guess between them — that is the cross-run mis-read.
    for (const [runId, messageId, content] of [
      ['run-a', 'message-a', 'a'],
      ['run-b', 'message-b', 'b']
    ] as const) {
      await repository.writePendingFile({
        projectName: 'default-project',
        sessionId: 'session-1',
        runId,
        filename: 'report.csv',
        source: createInlineSource(content)
      })
      await repository.finalizeRunArtifacts({
        projectName: 'default-project',
        sessionId: 'session-1',
        runId,
        messageId
      })
    }
    await rm(join(root, 'artifacts', 'default-project', 'session-1', '.runs'), {
      recursive: true,
      force: true
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
    await expect(repository.resolveManagedFilePath({ path: pendingPathA })).rejects.toThrow()
  })

  it('does NOT cross-read when a marker is present but corrupt and its target is gone', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    for (const [runId, messageId, content] of [
      ['run-a', 'message-a', 'a'],
      ['run-b', 'message-b', 'b']
    ] as const) {
      await repository.writePendingFile({
        projectName: 'default-project',
        sessionId: 'session-1',
        runId,
        filename: 'report.csv',
        source: createInlineSource(content)
      })
      await repository.finalizeRunArtifacts({
        projectName: 'default-project',
        sessionId: 'session-1',
        runId,
        messageId
      })
    }
    // Corrupt run-a's marker and delete its target file; run-b's identical-named file still exists.
    const runsDir = join(root, 'artifacts', 'default-project', 'session-1', '.runs')
    await writeFile(join(runsDir, 'run-a.json'), 'not json{', 'utf8')
    await rm(join(root, 'artifacts', 'default-project', 'session-1', 'message-a', 'report.csv'))

    const pendingPathA = join(
      root,
      'artifacts',
      'default-project',
      'session-1',
      '.pending',
      'run-a',
      'report.csv'
    )
    await expect(repository.resolveManagedFilePath({ path: pendingPathA })).rejects.toThrow()
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
    const files = await repository.listProjectArtifacts('default-project')

    expect(files.map((file) => file.name).sort()).toEqual(['alpha.txt', 'beta.txt'])
    expect(files.map((file) => file.sessionId).sort()).toEqual(['session-1', 'session-2'])
  })

  it('surfaces ownerless pending files (crash before attach) as orphaned artifacts', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    // A file written into a pending run whose turn crashed before the renderer attached it: no message
    // owns it, so startup reconciliation cannot claim it. It must still be surfaced, not hidden forever.
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-orphan',
      filename: 'draft.txt',
      source: createInlineSource('d')
    })

    const files = await repository.listProjectArtifacts('default-project')

    expect(files.map((file) => file.name)).toEqual(['draft.txt'])
    expect(files[0].runId).toBe('run-orphan')
    expect(files[0].path).toContain('.pending')
  })

  it('does not list the current-run handoff file as an artifact', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    // The handoff lives directly in `.pending/` (a file, not a run subdir), so the subdirectory walk
    // must skip it — otherwise it would show up as a bogus orphaned artifact.
    const handoff = getArtifactCurrentRunFilePath(root, 'default-project', 'session-1')
    await mkdir(dirname(handoff), { recursive: true })
    await writeFile(handoff, JSON.stringify({ runId: 'x' }), 'utf8')

    await expect(repository.listProjectArtifacts('default-project')).resolves.toEqual([])
  })

  it('excludes only the runs the caller reports as in-flight from the orphan scan', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    // An in-flight turn (run-active): its files are still being written.
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-active',
      filename: 'in-progress.txt',
      source: createInlineSource('partial')
    })
    // A genuinely orphaned pending run from an earlier crash.
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-dead',
      filename: 'orphan.txt',
      source: createInlineSource('dead')
    })

    // With run-active reported as live: only the dead run's file surfaces.
    const liveFiles = await repository.listProjectArtifacts(
      'default-project',
      new Set(['run-active'])
    )
    expect(liveFiles.map((file) => file.name)).toEqual(['orphan.txt'])
    expect(liveFiles[0].runId).toBe('run-dead')
  })

  it('surfaces every pending run when nothing is in flight (post-crash restart)', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)

    // A crash left a pending run AND its stale current-run.json handoff. On restart no run is live, so
    // the crashed run's files must surface — the persisted handoff must NOT keep hiding them.
    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-crashed',
      filename: 'crashed.txt',
      source: createInlineSource('x')
    })
    const handoff = getArtifactCurrentRunFilePath(root, 'default-project', 'session-1')
    await writeFile(handoff, JSON.stringify({ runId: 'run-crashed' }), 'utf8')

    // No active run ids (fresh runtime after restart).
    const files = await repository.listProjectArtifacts('default-project')

    expect(files.map((file) => file.name)).toEqual(['crashed.txt'])
    expect(files[0].runId).toBe('run-crashed')
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
