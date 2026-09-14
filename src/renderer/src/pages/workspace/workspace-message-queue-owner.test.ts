// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import {
  pendingInputContentSchema,
  type PendingInput,
  type PendingInputCommand,
  type PendingInputResult
} from '../../../../shared/pending-input'
import { toRuntimeUploadedAttachment } from '../../../../shared/uploads'
import { WorkspaceMessageQueueOwner } from './workspace-message-queue-owner'

const input = (): PendingInput => ({
  schemaVersion: 1,
  id: 'pending-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  agentFrameId: 'frame-1',
  messageBranchId: 'branch-1',
  text: 'Keep this input',
  forcedSkillIds: [],
  permissionProfile: 'ask',
  position: 1,
  revision: 1,
  phase: 'queued',
  snapshot: {
    draftKey: 'session-1',
    version: 1,
    doc: { nodes: [{ type: 'text', text: 'Keep this input' }] },
    annotations: [],
    attachments: []
  }
})
const snapshot = (item = input()): PendingInputResult => ({
  generation: 'main-1',
  revision: item.revision,
  items: [item],
  item
})

it('reconciles a lost admission response without losing the saved draft identity', async () => {
  const saved = input()
  saved.snapshot.attachments = [
    {
      id: 'upload-1',
      versionId: 'version-1',
      versionNumber: 1,
      sessionId: saved.sessionId,
      name: 'notes.txt',
      originalName: 'notes.txt',
      size: 5,
      sha256: 'sha256-test'
    }
  ]
  const execute = vi.fn(async (command: PendingInputCommand) => {
    if (command.operation === 'enqueue') throw new Error('reply lost')
    return snapshot(saved)
  })
  const owner = new WorkspaceMessageQueueOwner({ execute, onChanged: () => () => {} })
  const content = pendingInputContentSchema.strip().parse({
    ...saved,
    snapshot: {
      ...saved.snapshot,
      attachments: saved.snapshot.attachments.map((file) =>
        toRuntimeUploadedAttachment(file, saved.projectId)
      )
    }
  })
  await expect(owner.executeRemote({ operation: 'enqueue', content })).resolves.toMatchObject({
    item: { id: saved.id }
  })
  expect(owner.itemsFor(saved.sessionId)).toHaveLength(1)
  owner.dispose()
})

it('releases only the originating claim when its response is lost', async () => {
  let saved = input()
  const execute = vi.fn(async (command: PendingInputCommand) => {
    if (command.operation === 'claim') {
      saved = { ...saved, phase: 'sending', revision: 2 }
      throw new Error('claim reply lost')
    }
    if (command.operation === 'settle') {
      expect(command.claimId).toBe('claim-1')
      saved = { ...saved, phase: 'recovery-required', revision: 3 }
    }
    return snapshot(saved)
  })
  const owner = new WorkspaceMessageQueueOwner({ execute, onChanged: () => () => {} })
  await expect(
    owner.executeRemote({ operation: 'claim', id: saved.id, revision: 1, claimId: 'claim-1' })
  ).rejects.toThrow('claim reply lost')
  expect(owner.itemsFor(saved.sessionId)[0].phase).toBe('recovery-required')
  owner.dispose()
})

it('settles a late claim after disposal and never returns it to a sender', async () => {
  let release!: (result: PendingInputResult) => void
  const execute = vi.fn(async (command: PendingInputCommand) => {
    if (command.operation === 'claim')
      return new Promise<PendingInputResult>((resolve) => {
        release = resolve
      })
    return snapshot()
  })
  const owner = new WorkspaceMessageQueueOwner({ execute, onChanged: () => () => {} })
  await owner.connectRemote()
  const claim = owner.executeRemote({
    operation: 'claim',
    id: 'pending-1',
    revision: 1,
    claimId: 'claim-1'
  })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  owner.dispose()
  release(snapshot({ ...input(), phase: 'sending', revision: 2 }))
  await expect(claim).rejects.toThrow('unavailable')
  expect(execute).toHaveBeenCalledWith({
    operation: 'settle',
    id: 'pending-1',
    revision: 2,
    outcome: 'uncertain'
  })
  expect(owner.itemsFor('session-1')).toEqual([])
})

it('ignores older snapshots and retains recovered inputs on missing catalog hydration', async () => {
  let publish!: (result: PendingInputResult) => void
  const owner = new WorkspaceMessageQueueOwner({
    execute: async () => snapshot({ ...input(), phase: 'recovery-required', revision: 4 }),
    onChanged: (listener) => {
      publish = listener
      return () => {}
    }
  })
  await owner.connectRemote()
  publish(snapshot({ ...input(), revision: 2 }))
  expect(owner.itemsFor('session-1')[0].phase).toBe('recovery-required')
  const discard = vi.fn()
  owner.discardSession('session-1', discard)
  expect(discard).not.toHaveBeenCalled()
  owner.dispose()
})

it('restores path-free durable attachments as scoped version references', async () => {
  const saved = input()
  saved.snapshot.attachments = [
    {
      id: 'upload-1',
      versionId: 'version-1',
      versionNumber: 1,
      sessionId: saved.sessionId,
      name: 'notes.txt',
      originalName: 'notes.txt',
      size: 5,
      sha256: 'sha256-test'
    }
  ]
  const owner = new WorkspaceMessageQueueOwner({
    execute: async () => snapshot(saved),
    onChanged: () => () => {}
  })
  await owner.connectRemote()
  expect(owner.itemsFor(saved.sessionId)[0].snapshot?.attachments).toEqual([
    {
      id: 'upload-1',
      versionId: 'version-1',
      versionNumber: 1,
      sessionId: saved.sessionId,
      name: 'notes.txt',
      originalName: 'notes.txt',
      size: 5,
      checksum: 'sha256-test',
      path: 'upload-version:project-1/session-1/upload-1/version-1'
    }
  ])
  owner.dispose()
})
