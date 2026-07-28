import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import {
  ConversationSkillImporter,
  SkillImportApprovalBroker,
  type SkillImportApprovalInfo
} from './conversation-import'
import { UserSkillRepository } from './user-skill-repository'

const roots: string[] = []
const disconnects: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(disconnects.splice(0).map((disconnect) => disconnect()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    let current = (crc ^ buffer[index]) & 0xff
    for (let bit = 0; bit < 8; bit += 1) {
      current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
    }
    crc = (crc >>> 8) ^ current
  }
  return (crc ^ 0xffffffff) >>> 0
}

const buildZip = (inputs: { path: string; content: Buffer }[]): Buffer => {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const input of inputs) {
    const name = Buffer.from(input.path, 'utf8')
    const stored = deflateRawSync(input.content)
    const crc = crc32(input.content)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(input.content.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    locals.push(local, stored)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(input.content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length + stored.length
  }

  const localBytes = Buffer.concat(locals)
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(inputs.length, 8)
  end.writeUInt16LE(inputs.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(localBytes.length, 16)
  return Buffer.concat([localBytes, centralBytes, end])
}

const buildNamedSkillZip = (name: string): Buffer =>
  buildZip([
    {
      path: 'SKILL.md',
      content: Buffer.from(`---\nname: ${name}\n---\nFollow the workflow.`, 'utf8')
    }
  ])

const createActiveCancellationGuard = (): { isCancelled: () => boolean } => ({
  isCancelled: () => false
})

describe('ConversationSkillImporter', () => {
  it('imports a session-owned Skill attachment after the user confirms its preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const uploads = new UploadRepository(root)
    const skills = new UserSkillRepository(root)
    const zip = buildZip([
      {
        path: 'paper-finder/SKILL.md',
        content: Buffer.from(
          '---\nname: Paper Finder\ndescription: Finds relevant papers.\n---\nFollow the workflow.',
          'utf8'
        )
      }
    ])
    const [staged] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'paper-finder.skill',
          content: zip.toString('base64'),
          mimeType: 'application/zip'
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-1', [staged])
    const onSkillsChanged = vi.fn()
    const broker = new SkillImportApprovalBroker({
      generateId: () => 'approval-1',
      broadcast: (request) => {
        expect(request.attachmentName).toBe('paper-finder.skill')
        expect(request.previews.map((preview) => preview.name)).toEqual(['Paper Finder'])
        broker.respond({
          id: request.id,
          items: [{ subPath: request.previews[0].subPath }]
        })
      }
    })
    const importer = new ConversationSkillImporter({
      uploads,
      createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
        broker.createCancellationGuard(sessionId, turnToken, attachmentUri),
      previewBundle: (bundle) => skills.previewZip(bundle),
      importBundle: (bundle, items) => skills.importFromZipBatch(bundle, items),
      requestApproval: (request, cancellation) => broker.request(request, cancellation),
      onSkillsChanged
    })
    broker.beginSessionTurn('session-1', 'turn-1')
    broker.allowSessionTurnAttachment('session-1', 'turn-1', pathToFileURL(attachment.path).href)

    const result = await importer.request({
      sessionId: 'session-1',
      turnToken: 'turn-1',
      attachmentUri: pathToFileURL(attachment.path).href
    })

    expect(result).toEqual({
      status: 'imported',
      skills: [{ id: 'imported-paper-finder', name: 'Paper Finder', status: 'imported' }]
    })
    expect((await skills.list()).map((skill) => skill.name)).toEqual(['Paper Finder'])
    expect(onSkillsChanged).toHaveBeenCalledOnce()
  })

  it('imports a native project-scoped Upload Version using its verified Session ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const client = createProjectDbClient(root)
    disconnects.push(() => client.$disconnect())
    await ensureProjectSchema(client)
    const uploads = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const skills = new UserSkillRepository(root)
    const [staged] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'project-skill.zip',
          content: buildNamedSkillZip('Project Skill').toString('base64'),
          mimeType: 'application/zip'
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads(
      'session-1',
      [staged],
      'project-1'
    )
    const broker = new SkillImportApprovalBroker({
      generateId: () => 'approval-project-upload',
      broadcast: (request) =>
        broker.respond({
          id: request.id,
          items: request.previews.map((preview) => ({ subPath: preview.subPath }))
        })
    })
    const importer = new ConversationSkillImporter({
      uploads,
      createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
        broker.createCancellationGuard(sessionId, turnToken, attachmentUri),
      previewBundle: (bundle) => skills.previewZip(bundle),
      importBundle: (bundle, items) => skills.importFromZipBatch(bundle, items),
      requestApproval: (request, cancellation) => broker.request(request, cancellation)
    })
    const attachmentUri = pathToFileURL(attachment.path).href
    broker.beginSessionTurn('session-1', 'turn-1')
    broker.allowSessionTurnAttachment('session-1', 'turn-1', attachmentUri)

    await expect(
      importer.request({
        sessionId: 'session-1',
        turnToken: 'turn-1',
        attachmentUri
      })
    ).resolves.toEqual({
      status: 'imported',
      skills: [{ id: 'imported-project-skill', name: 'Project Skill', status: 'imported' }]
    })
  })

  it('imports an explicitly referenced legacy upload from another Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const uploads = new UploadRepository(root)
    const skills = new UserSkillRepository(root)
    const [staged] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'shared-skill.zip',
          content: buildNamedSkillZip('Shared Skill').toString('base64'),
          mimeType: 'application/zip'
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('source-session', [staged])
    const broker = new SkillImportApprovalBroker({
      generateId: () => 'approval-cross-session-upload',
      broadcast: (request) =>
        broker.respond({
          id: request.id,
          items: request.previews.map((preview) => ({ subPath: preview.subPath }))
        })
    })
    const importer = new ConversationSkillImporter({
      uploads,
      createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
        broker.createCancellationGuard(sessionId, turnToken, attachmentUri),
      previewBundle: (bundle) => skills.previewZip(bundle),
      importBundle: (bundle, items) => skills.importFromZipBatch(bundle, items),
      requestApproval: (request, cancellation) => broker.request(request, cancellation)
    })
    const attachmentUri = pathToFileURL(attachment.path).href

    const disposeGrant = await importer.authorizeReferencedUploads('project-1', 'target-session', [
      attachment.path
    ])
    broker.beginSessionTurn('target-session', 'turn-1')
    broker.allowSessionTurnAttachment('target-session', 'turn-1', attachmentUri)

    await expect(
      importer.request({
        sessionId: 'target-session',
        turnToken: 'turn-1',
        attachmentUri
      })
    ).resolves.toEqual({
      status: 'imported',
      skills: [{ id: 'imported-shared-skill', name: 'Shared Skill', status: 'imported' }]
    })
    disposeGrant()
  })

  it('rejects an attachment owned by another conversation before showing approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const uploads = new UploadRepository(root)
    const skills = new UserSkillRepository(root)
    const zip = buildZip([
      {
        path: 'SKILL.md',
        content: Buffer.from('---\nname: Private Skill\n---\nDo the thing.', 'utf8')
      }
    ])
    const [staged] = await stageUploadFixtures(uploads, {
      files: [{ name: 'private.skill', content: zip.toString('base64') }]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-2', [staged])
    const requestApproval = vi.fn()
    const importer = new ConversationSkillImporter({
      uploads,
      createCancellationGuard: createActiveCancellationGuard,
      previewBundle: (bundle) => skills.previewZip(bundle),
      importBundle: (bundle, items) => skills.importFromZipBatch(bundle, items),
      requestApproval
    })

    await expect(
      importer.request({
        sessionId: 'session-1',
        turnToken: 'turn-1',
        attachmentUri: pathToFileURL(attachment.path).href
      })
    ).rejects.toThrow(/different (?:project or )?session/)
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('rejects an ordinary session ZIP before preview or approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const uploads = new UploadRepository(root)
    const [staged] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'ordinary-data.zip',
          content: buildZip([
            { path: 'README.txt', content: Buffer.from('ordinary archive', 'utf8') }
          ]).toString('base64'),
          mimeType: 'application/zip'
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-1', [staged])
    const previewBundle = vi.fn()
    const requestApproval = vi.fn()
    const importer = new ConversationSkillImporter({
      uploads,
      createCancellationGuard: createActiveCancellationGuard,
      previewBundle,
      importBundle: vi.fn(),
      requestApproval
    })

    await expect(
      importer.request({
        sessionId: 'session-1',
        turnToken: 'turn-1',
        attachmentUri: pathToFileURL(attachment.path).href
      })
    ).rejects.toThrow('not eligible for Skill import')
    expect(previewBundle).not.toHaveBeenCalled()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('rejects a session-owned Skill archive that was not eligible in the active turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const uploads = new UploadRepository(root)
    const [staged] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'older-turn.skill',
          content: buildNamedSkillZip('Older Turn').toString('base64'),
          mimeType: 'application/zip'
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-1', [staged])
    const previewBundle = vi.fn()
    const requestApproval = vi.fn()
    const broker = new SkillImportApprovalBroker({
      generateId: () => 'unused',
      broadcast: vi.fn()
    })
    const importer = new ConversationSkillImporter({
      uploads,
      createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
        broker.createCancellationGuard(sessionId, turnToken, attachmentUri),
      previewBundle,
      importBundle: vi.fn(),
      requestApproval
    })
    broker.beginSessionTurn('session-1', 'turn-2')
    broker.allowSessionTurnAttachment('session-1', 'turn-2', 'file:///current-turn.skill')

    await expect(
      importer.request({
        sessionId: 'session-1',
        turnToken: 'turn-2',
        attachmentUri: pathToFileURL(attachment.path).href
      })
    ).resolves.toEqual({ status: 'cancelled', skills: [] })
    expect(previewBundle).not.toHaveBeenCalled()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('cancels imports stopped during preview and requests that arrive after the stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const uploads = new UploadRepository(root)
    const skills = new UserSkillRepository(root)
    const [staged] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'slow-preview.skill',
          content: buildNamedSkillZip('Slow Preview').toString('base64'),
          mimeType: 'application/zip'
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-1', [staged])
    let markPreviewStarted!: () => void
    let releasePreview!: () => void
    const previewStarted = new Promise<void>((resolve) => {
      markPreviewStarted = resolve
    })
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve
    })
    const broadcast = vi.fn()
    const broker = new SkillImportApprovalBroker({
      generateId: () => 'approval-late',
      broadcast
    })
    const importBundle = vi.fn()
    const previewBundle = vi.fn(async (bundle: Buffer) => {
      const preview = await skills.previewZip(bundle)
      markPreviewStarted()
      await previewGate
      return preview
    })
    const importer = new ConversationSkillImporter({
      uploads,
      createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
        broker.createCancellationGuard(sessionId, turnToken, attachmentUri),
      previewBundle,
      importBundle,
      requestApproval: (request, cancellation) => broker.request(request, cancellation)
    })

    broker.beginSessionTurn('session-1', 'turn-1')
    broker.allowSessionTurnAttachment('session-1', 'turn-1', pathToFileURL(attachment.path).href)
    const importing = importer.request({
      sessionId: 'session-1',
      turnToken: 'turn-1',
      attachmentUri: pathToFileURL(attachment.path).href
    })
    await previewStarted
    broker.cancelSession('session-1')
    releasePreview()

    await expect(importing).resolves.toEqual({ status: 'cancelled', skills: [] })
    expect(broadcast).not.toHaveBeenCalled()
    expect(importBundle).not.toHaveBeenCalled()

    broker.beginSessionTurn('session-1', 'turn-2')
    broker.allowSessionTurnAttachment('session-1', 'turn-2', pathToFileURL(attachment.path).href)
    await expect(
      importer.request({
        sessionId: 'session-1',
        turnToken: 'turn-1',
        attachmentUri: pathToFileURL(attachment.path).href
      })
    ).resolves.toEqual({ status: 'cancelled', skills: [] })
    expect(previewBundle).toHaveBeenCalledOnce()
  })

  it('rejects two approved candidates that replace the same installed Skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const uploads = new UploadRepository(root)
    const [staged] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'duplicate-targets.skill',
          content: buildNamedSkillZip('Duplicate Targets').toString('base64'),
          mimeType: 'application/zip'
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-1', [staged])
    const importBundle = vi.fn().mockResolvedValue([])
    const importer = new ConversationSkillImporter({
      uploads,
      createCancellationGuard: createActiveCancellationGuard,
      previewBundle: vi.fn().mockResolvedValue({
        previews: [
          {
            subPath: 'first',
            name: 'Shared Skill',
            description: '',
            metadata: {},
            body: '',
            files: ['SKILL.md'],
            alreadyImported: false,
            replaceableId: 'imported-shared'
          },
          {
            subPath: 'second',
            name: 'Shared Skill',
            description: '',
            metadata: {},
            body: '',
            files: ['SKILL.md'],
            alreadyImported: false,
            replaceableId: 'imported-shared'
          }
        ],
        skipped: []
      }),
      importBundle,
      requestApproval: vi.fn().mockResolvedValue({
        id: 'approval-duplicate-targets',
        items: [
          { subPath: 'first', replaceId: 'imported-shared' },
          { subPath: 'second', replaceId: 'imported-shared' }
        ]
      })
    })

    await expect(
      importer.request({
        sessionId: 'session-1',
        turnToken: 'turn-1',
        attachmentUri: pathToFileURL(attachment.path).href
      })
    ).rejects.toThrow('cannot replace the same installed Skill more than once')
    expect(importBundle).not.toHaveBeenCalled()
  })

  it('rejects an approval that drops the previewed replacement target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const uploads = new UploadRepository(root)
    const [staged] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'replacement.skill',
          content: buildNamedSkillZip('Replacement').toString('base64'),
          mimeType: 'application/zip'
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-1', [staged])
    const importBundle = vi.fn().mockResolvedValue([])
    const importer = new ConversationSkillImporter({
      uploads,
      createCancellationGuard: createActiveCancellationGuard,
      previewBundle: vi.fn().mockResolvedValue({
        previews: [
          {
            subPath: 'replacement',
            name: 'Existing Skill',
            description: '',
            metadata: {},
            body: '',
            files: ['SKILL.md'],
            alreadyImported: false,
            replaceableId: 'imported-existing'
          }
        ],
        skipped: []
      }),
      importBundle,
      requestApproval: vi.fn().mockResolvedValue({
        id: 'approval-replacement',
        items: [{ subPath: 'replacement' }]
      })
    })

    await expect(
      importer.request({
        sessionId: 'session-1',
        turnToken: 'turn-1',
        attachmentUri: pathToFileURL(attachment.path).href
      })
    ).rejects.toThrow('replacement target does not match the approved preview')
    expect(importBundle).not.toHaveBeenCalled()
  })
})

describe('SkillImportApprovalBroker lifecycle', () => {
  const approvalInfo = (sessionId: string): SkillImportApprovalInfo => ({
    sessionId,
    attachmentName: 'demo.skill',
    previews: [],
    skipped: []
  })

  it('settles and dismisses a request when its timeout expires', async () => {
    vi.useFakeTimers()
    const onSettled = vi.fn()
    const broker = new SkillImportApprovalBroker({
      generateId: () => 'approval-timeout',
      broadcast: vi.fn(),
      onSettled,
      timeoutMs: 10
    })
    const response = broker.request(approvalInfo('session-1'))

    await vi.advanceTimersByTimeAsync(10)

    await expect(response).resolves.toEqual({ id: 'approval-timeout', cancelled: true })
    expect(onSettled).toHaveBeenCalledWith('approval-timeout')
  })

  it('cancels only approvals owned by the stopped conversation', async () => {
    const onSettled = vi.fn()
    let sequence = 0
    const broker = new SkillImportApprovalBroker({
      generateId: () => `approval-${++sequence}`,
      broadcast: vi.fn(),
      onSettled
    })
    const cancelled = broker.request(approvalInfo('session-1'))
    const retained = broker.request(approvalInfo('session-2'))

    broker.cancelSession('session-1')
    broker.respond({ id: 'approval-2', items: [] })

    await expect(cancelled).resolves.toEqual({ id: 'approval-1', cancelled: true })
    await expect(retained).resolves.toEqual({ id: 'approval-2', items: [] })
    expect(onSettled).toHaveBeenCalledTimes(2)
  })

  it('binds guards to one active turn token across cancellation and later turns', () => {
    const broker = new SkillImportApprovalBroker({
      generateId: () => 'unused',
      broadcast: vi.fn()
    })
    broker.beginSessionTurn('session-1', 'turn-1')
    broker.beginSessionTurn('session-2', 'turn-a')
    broker.allowSessionTurnAttachment('session-1', 'turn-1', 'file:///current.skill')
    broker.allowSessionTurnAttachment('session-2', 'turn-a', 'file:///second.skill')
    const first = broker.createCancellationGuard('session-1', 'turn-1', 'file:///current.skill')
    const unlisted = broker.createCancellationGuard('session-1', 'turn-1', 'file:///older.skill')
    const second = broker.createCancellationGuard('session-2', 'turn-a', 'file:///second.skill')
    expect(first.isCancelled()).toBe(false)
    expect(unlisted.isCancelled()).toBe(true)

    broker.cancelSession('session-1')
    expect(first.isCancelled()).toBe(true)
    expect(second.isCancelled()).toBe(false)

    broker.cancelAll()
    expect(second.isCancelled()).toBe(true)

    broker.beginSessionTurn('session-1', 'turn-2')
    broker.allowSessionTurnAttachment('session-1', 'turn-2', 'file:///next.skill')
    expect(first.isCancelled()).toBe(true)
    const next = broker.createCancellationGuard('session-1', 'turn-2', 'file:///next.skill')
    expect(next.isCancelled()).toBe(false)
    broker.endSessionTurn('session-1', 'turn-2')
    expect(next.isCancelled()).toBe(true)
  })

  it('cancels every pending approval when all agent runtimes disconnect', async () => {
    const onSettled = vi.fn()
    let sequence = 0
    const broker = new SkillImportApprovalBroker({
      generateId: () => `approval-${++sequence}`,
      broadcast: vi.fn(),
      onSettled
    })
    const first = broker.request(approvalInfo('session-1'))
    const second = broker.request(approvalInfo('session-2'))

    broker.cancelAll()

    await expect(first).resolves.toEqual({ id: 'approval-1', cancelled: true })
    await expect(second).resolves.toEqual({ id: 'approval-2', cancelled: true })
    expect(onSettled).toHaveBeenCalledTimes(2)
  })

  it('retains pending approval payloads so a recreated renderer can recover them', async () => {
    const broadcast = vi.fn()
    const broker = new SkillImportApprovalBroker({
      generateId: () => 'approval-recoverable',
      broadcast
    })
    const info = approvalInfo('session-1')

    const response = broker.request(info)
    broadcast.mockClear()

    broker.replayPending()
    expect(broadcast).toHaveBeenCalledWith({ id: 'approval-recoverable', ...info })

    broker.respond({ id: 'approval-recoverable', cancelled: true })
    await response
    broadcast.mockClear()
    broker.replayPending()
    expect(broadcast).not.toHaveBeenCalled()
  })
})
