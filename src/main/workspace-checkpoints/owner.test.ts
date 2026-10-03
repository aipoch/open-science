import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import { sanitizeConversationGraph } from '../../shared/session-persistence/conversation-graph'
import { WorkspaceCheckpointOwner } from './owner'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace checkpoint owner', () => {
  it('references large workspace files without copying their bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-reference-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'stream.bin'), '0123456789')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot, maxBlobBytes: 8 })

    const result = await owner.checkpointExplicitly({
      graph,
      sessionId: 'session-1',
      branchId: graph.branches[0].id,
      workspaceRoot
    })

    expect(result.checkpoint.trigger).toBe('explicit')
    expect(result.checkpoint.entries).toEqual([
      expect.objectContaining({ kind: 'reference', path: 'stream.bin', sizeBytes: 10 })
    ])
    await expect(
      readdir(join(checkpointRoot, 'content', 'blobs')).catch(() => [])
    ).resolves.toEqual([])
  })

  it('reuses one content blob for unchanged files across turn-boundary checkpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await writeFile(join(root, 'ignored.txt'), 'outside')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'sample\n')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'analyze',
          createdAt: 1,
          updatedAt: 1,
          status: 'complete',
          eventIds: []
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot, maxBlobBytes: 1024 })

    const first = await owner.checkpointTurnBoundary({
      graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })
    const second = await owner.checkpointTurnBoundary({
      graph: first.graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })

    expect(first.checkpoint.entries).toHaveLength(1)
    expect(second.checkpoint.entries).toHaveLength(1)
    const firstEntry = first.checkpoint.entries[0]
    const secondEntry = second.checkpoint.entries[0]
    expect(firstEntry?.kind).toBe('file')
    expect(secondEntry).toMatchObject({
      kind: 'file',
      path: 'data.csv',
      contentId: firstEntry?.kind === 'file' ? firstEntry.contentId : undefined
    })
    await expect(readFile(join(workspaceRoot, 'data.csv'), 'utf8')).resolves.toBe('sample\n')
  })
  it('previews add, modify, delete, rename, binary and referenced changes without mutating files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-preview-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'v1\n')
    await writeFile(join(workspaceRoot, 'deleted.txt'), 'restore me')
    await writeFile(join(workspaceRoot, 'old-name.txt'), 'rename me')
    await writeFile(join(workspaceRoot, 'image.bin'), Buffer.from([0, 1, 2, 255]))
    await writeFile(join(workspaceRoot, 'stream.bin'), 'x'.repeat(32))
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const branch = graph.branches[0]
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot, maxBlobBytes: 16 })
    const captured = await owner.checkpointTurnBoundary({
      graph,
      sessionId: 'session-1',
      branchId: branch.id,
      workspaceRoot
    })

    expect(captured.graph.branches[0].workspaceCheckpointId).toBe(captured.checkpoint.id)
    expect(captured.checkpoint.binding).toMatchObject({
      branchId: branch.id,
      agentFrameId: branch.agentFrameId,
      branchUpdatedAt: branch.updatedAt
    })

    await writeFile(join(workspaceRoot, 'data.csv'), 'v2\n')
    await rm(join(workspaceRoot, 'deleted.txt'))
    await rename(join(workspaceRoot, 'old-name.txt'), join(workspaceRoot, 'new-name.txt'))
    await writeFile(join(workspaceRoot, 'added.txt'), 'new')

    const preview = await owner.previewRestore({
      graph: captured.graph,
      sessionId: 'session-1',
      branchId: branch.id,
      workspaceRoot
    })

    expect(preview.checkpointId).toBe(captured.checkpoint.id)
    expect(preview.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'added.txt', change: 'delete' }),
        expect.objectContaining({ path: 'data.csv', change: 'modify' }),
        expect.objectContaining({ path: 'deleted.txt', change: 'add' }),
        expect.objectContaining({ path: 'new-name.txt', change: 'delete' }),
        expect.objectContaining({ path: 'old-name.txt', change: 'add' }),
        expect.objectContaining({ path: 'stream.bin', kind: 'reference', change: 'reference' })
      ])
    )
    expect(preview.previewToken).toMatch(/^[a-f0-9]{64}$/)
    await expect(readFile(join(workspaceRoot, 'data.csv'), 'utf8')).resolves.toBe('v2\n')
    await expect(readFile(join(workspaceRoot, 'new-name.txt'), 'utf8')).resolves.toBe('rename me')
  })

  it('keeps the branch-bound checkpoint previewable after later messages advance the branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-branch-advance-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'v1\n')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'analyze',
          createdAt: 1,
          updatedAt: 1,
          status: 'complete',
          eventIds: []
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot })
    const captured = await owner.checkpointTurnBoundary({
      graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })
    const advanced = synchronizeActiveConversationMessages(
      captured.graph,
      [
        {
          id: 'agent-2',
          role: 'agent',
          content: 'done',
          responseToMessageId: 'user-1',
          createdAt: 2,
          updatedAt: 2,
          status: 'complete',
          eventIds: []
        }
      ],
      2
    )

    await expect(
      owner.previewRestore({
        graph: advanced,
        sessionId: 'session-1',
        branchId,
        workspaceRoot
      })
    ).resolves.toMatchObject({ checkpointId: captured.checkpoint.id })
  })

  it('requires explicit confirmation and restores deletes, renames, binary files and reference state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-restore-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    const originalBinary = Buffer.from([0, 1, 2, 255, 0, 127])
    await writeFile(join(workspaceRoot, 'data.csv'), 'v1\n')
    await writeFile(join(workspaceRoot, 'deleted.txt'), 'restore me')
    await writeFile(join(workspaceRoot, 'old-name.txt'), 'rename me')
    await writeFile(join(workspaceRoot, 'image.bin'), originalBinary)
    await writeFile(join(workspaceRoot, 'stream.bin'), 'x'.repeat(64))
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot, maxBlobBytes: 32 })
    const captured = await owner.checkpointExplicitly({
      graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })

    await writeFile(join(workspaceRoot, 'data.csv'), 'v2\n')
    await writeFile(join(workspaceRoot, 'image.bin'), Buffer.from([9, 9]))
    await rm(join(workspaceRoot, 'deleted.txt'))
    await rename(join(workspaceRoot, 'old-name.txt'), join(workspaceRoot, 'new-name.txt'))
    await writeFile(join(workspaceRoot, 'added.txt'), 'remove')

    const preview = await owner.previewRestore({
      graph: captured.graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })

    await expect(
      owner.restore({
        graph: captured.graph,
        sessionId: 'session-1',
        branchId,
        workspaceRoot,
        previewToken: preview.previewToken
      })
    ).rejects.toThrow(/confirmation/i)
    await expect(readFile(join(workspaceRoot, 'data.csv'), 'utf8')).resolves.toBe('v2\n')

    await expect(
      owner.restore({
        graph: captured.graph,
        sessionId: 'session-1',
        branchId,
        workspaceRoot,
        previewToken: '0'.repeat(64),
        confirm: true
      })
    ).rejects.toThrow(/preview/i)
    await expect(readFile(join(workspaceRoot, 'data.csv'), 'utf8')).resolves.toBe('v2\n')

    const restored = await owner.restore({
      graph: captured.graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot,
      previewToken: preview.previewToken,
      confirm: true
    })

    expect(restored).toMatchObject({ checkpointId: captured.checkpoint.id, restored: true })
    await expect(readFile(join(workspaceRoot, 'data.csv'), 'utf8')).resolves.toBe('v1\n')
    await expect(readFile(join(workspaceRoot, 'deleted.txt'), 'utf8')).resolves.toBe('restore me')
    await expect(readFile(join(workspaceRoot, 'old-name.txt'), 'utf8')).resolves.toBe('rename me')
    await expect(readFile(join(workspaceRoot, 'new-name.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(workspaceRoot, 'added.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(workspaceRoot, 'image.bin'))).resolves.toEqual(originalBinary)
    await expect(readFile(join(workspaceRoot, 'stream.bin'), 'utf8')).resolves.toBe('x'.repeat(64))
  })

  it('recovers an interrupted restore from its durable journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-crash-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'v1\n')
    await writeFile(join(workspaceRoot, 'notes.txt'), 'keep me')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot })
    const captured = await owner.checkpointTurnBoundary({
      graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })

    await writeFile(join(workspaceRoot, 'data.csv'), 'v2\n')
    const preview = await owner.previewRestore({
      graph: captured.graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })
    const crash = new Error('simulated crash after first restore mutation')
    const crashingOwner = new WorkspaceCheckpointOwner({
      checkpointRoot,
      restoreHooks: {
        afterMutation: async () => {
          throw crash
        }
      }
    })

    await expect(
      crashingOwner.restore({
        graph: captured.graph,
        sessionId: 'session-1',
        branchId,
        workspaceRoot,
        previewToken: preview.previewToken,
        confirm: true
      })
    ).rejects.toBe(crash)
    await expect(readFile(join(workspaceRoot, 'data.csv'), 'utf8')).resolves.toBe('v1\n')

    const recoveryOwner = new WorkspaceCheckpointOwner({ checkpointRoot })
    await recoveryOwner.recoverPendingRestores()

    await expect(readFile(join(workspaceRoot, 'data.csv'), 'utf8')).resolves.toBe('v1\n')
    await expect(readFile(join(workspaceRoot, 'notes.txt'), 'utf8')).resolves.toBe('keep me')
  })

  it('rejects symlink entries that would escape the workspace containment root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-containment-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'outside')
    await symlink(outside, join(workspaceRoot, 'escaped.txt'))
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot })

    await expect(
      owner.checkpointTurnBoundary({
        graph,
        sessionId: 'session-1',
        branchId,
        workspaceRoot
      })
    ).rejects.toThrow(/symbolic links/i)

    await rm(join(workspaceRoot, 'escaped.txt'))
    const captured = await owner.checkpointTurnBoundary({
      graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })
    await symlink(outside, join(workspaceRoot, 'escaped.txt'))

    await expect(
      owner.previewRestore({
        graph: captured.graph,
        sessionId: 'session-1',
        branchId,
        workspaceRoot
      })
    ).rejects.toThrow(/symbolic links/i)
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside')
  })

  it('previews a sibling branch checkpoint without restoring it to the active branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-branch-switch-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'v1\n')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'analyze',
          createdAt: 1,
          updatedAt: 1,
          status: 'complete',
          eventIds: []
        },
        {
          id: 'agent-1',
          role: 'agent',
          content: 'done',
          responseToMessageId: 'user-1',
          createdAt: 1,
          updatedAt: 1,
          status: 'complete',
          eventIds: []
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })
    const originalBranchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot })
    const captured = await owner.checkpointTurnBoundary({
      graph,
      sessionId: 'session-1',
      branchId: originalBranchId,
      workspaceRoot
    })
    const sibling = forkEditedConversationMessage(captured.graph, 'user-1', 'branch-sibling', 2)
    await writeFile(join(workspaceRoot, 'data.csv'), 'v2\n')

    const preview = await owner.previewRestore({
      graph: sibling,
      sessionId: 'session-1',
      branchId: originalBranchId,
      workspaceRoot
    })

    expect(preview).toMatchObject({
      checkpointId: captured.checkpoint.id,
      branchId: originalBranchId
    })
    expect(preview.entries).toEqual([
      expect.objectContaining({ path: 'data.csv', change: 'modify' })
    ])

    await expect(
      owner.restore({
        graph: sibling,
        sessionId: 'session-1',
        branchId: originalBranchId,
        workspaceRoot,
        previewToken: preview.previewToken,
        confirm: true
      })
    ).rejects.toThrow(/active Message Branch/i)
    await expect(readFile(join(workspaceRoot, 'data.csv'), 'utf8')).resolves.toBe('v2\n')
  })

  it('preserves the message-branch checkpoint binding through the session graph codec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-codec-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'v1\n')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot })
    const captured = await owner.checkpointTurnBoundary({
      graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })

    const decoded = sanitizeConversationGraph(captured.graph)

    expect(decoded?.branches[0].workspaceCheckpointId).toBe(captured.checkpoint.id)
  })

  it('serializes concurrent restores so only the first preview token succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-concurrent-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'v1\n')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot })
    const captured = await owner.checkpointTurnBoundary({
      graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })
    await writeFile(join(workspaceRoot, 'data.csv'), 'v2\n')
    const preview = await owner.previewRestore({
      graph: captured.graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })

    const results = await Promise.allSettled([
      owner.restore({
        graph: captured.graph,
        sessionId: 'session-1',
        branchId,
        workspaceRoot,
        previewToken: preview.previewToken,
        confirm: true
      }),
      owner.restore({
        graph: captured.graph,
        sessionId: 'session-1',
        branchId,
        workspaceRoot,
        previewToken: preview.previewToken,
        confirm: true
      })
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(readFile(join(workspaceRoot, 'data.csv'), 'utf8')).resolves.toBe('v1\n')
  })

  it('keeps one immutable blob when concurrent checkpoints observe the same unchanged file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-blob-dedupe-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'stable\n')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const firstOwner = new WorkspaceCheckpointOwner({ checkpointRoot })
    const secondOwner = new WorkspaceCheckpointOwner({ checkpointRoot })

    const results = await Promise.all([
      firstOwner.checkpointExplicitly({
        graph,
        sessionId: 'session-1',
        branchId,
        workspaceRoot
      }),
      secondOwner.checkpointExplicitly({
        graph,
        sessionId: 'session-1',
        branchId,
        workspaceRoot
      })
    ])

    const entry = results[0].checkpoint.entries[0]
    expect(entry?.kind).toBe('file')
    if (entry?.kind !== 'file') throw new Error('Expected a file checkpoint entry.')
    await expect(
      readdir(join(checkpointRoot, 'content', 'blobs', entry.checksum.slice(0, 2)))
    ).resolves.toEqual([entry.checksum])
  })

  it('fails before mutation when a checkpoint blob is corrupted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-corrupt-blob-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'v1\n')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot })
    const captured = await owner.checkpointTurnBoundary({
      graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })
    const entry = captured.checkpoint.entries[0]
    if (entry?.kind !== 'file') throw new Error('Expected a file checkpoint entry.')
    await writeFile(
      join(checkpointRoot, 'content', 'blobs', entry.checksum.slice(0, 2), entry.checksum),
      'corrupt'
    )
    await writeFile(join(workspaceRoot, 'data.csv'), 'v2\n')
    const preview = await owner.previewRestore({
      graph: captured.graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })

    await expect(
      owner.restore({
        graph: captured.graph,
        sessionId: 'session-1',
        branchId,
        workspaceRoot,
        previewToken: preview.previewToken,
        confirm: true
      })
    ).rejects.toThrow(/blob is invalid/i)
    await expect(readFile(join(workspaceRoot, 'data.csv'), 'utf8')).resolves.toBe('v2\n')
  })

  it('refuses to place checkpoint storage inside the workspace containment root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-store-containment-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(workspaceRoot, '.checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'v1\n')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot })

    await expect(
      owner.checkpointTurnBoundary({
        graph,
        sessionId: 'session-1',
        branchId: graph.branches[0].id,
        workspaceRoot
      })
    ).rejects.toThrow(/outside the workspace/i)
  })

  it('refuses checkpoint storage symlinked into the workspace containment root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-store-symlink-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointTarget = join(workspaceRoot, '.checkpoint-data')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'data.csv'), 'v1\n')
    await symlink(checkpointTarget, checkpointRoot, 'dir')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot })

    await expect(
      owner.checkpointTurnBoundary({
        graph,
        sessionId: 'session-1',
        branchId: graph.branches[0].id,
        workspaceRoot
      })
    ).rejects.toThrow(/outside the workspace/i)
    await expect(lstat(checkpointTarget)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('marks missing referenced inputs as unavailable instead of planning an unsafe add', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-reference-missing-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'stream.bin'), '0123456789')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot, maxBlobBytes: 4 })
    const captured = await owner.checkpointExplicitly({
      graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })
    await rm(join(workspaceRoot, 'stream.bin'))

    const preview = await owner.previewRestore({
      graph: captured.graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })

    expect(preview.restoreable).toBe(false)
    expect(preview.entries).toEqual([
      expect.objectContaining({
        path: 'stream.bin',
        kind: 'reference',
        change: 'reference-changed'
      })
    ])
  })

  it('restores a directory path when the current workspace replaced it with a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-checkpoint-path-shape-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const checkpointRoot = join(root, 'checkpoints')
    await mkdir(join(workspaceRoot, 'results'), { recursive: true })
    await writeFile(join(workspaceRoot, 'results', 'summary.txt'), 'complete\n')
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const branchId = graph.branches[0].id
    const owner = new WorkspaceCheckpointOwner({ checkpointRoot })
    const captured = await owner.checkpointTurnBoundary({
      graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })
    await rm(join(workspaceRoot, 'results'), { recursive: true })
    await writeFile(join(workspaceRoot, 'results'), 'wrong shape')

    const preview = await owner.previewRestore({
      graph: captured.graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot
    })
    await owner.restore({
      graph: captured.graph,
      sessionId: 'session-1',
      branchId,
      workspaceRoot,
      previewToken: preview.previewToken,
      confirm: true
    })

    await expect(readFile(join(workspaceRoot, 'results', 'summary.txt'), 'utf8')).resolves.toBe(
      'complete\n'
    )
  })
})
