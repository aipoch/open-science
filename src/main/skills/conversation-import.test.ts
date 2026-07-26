import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { UploadRepository } from '../uploads/repository'
import {
  ConversationSkillImporter,
  SkillImportApprovalBroker,
  type SkillImportApprovalInfo
} from './conversation-import'
import { UserSkillRepository } from './user-skill-repository'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
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
    const [staged] = await uploads.stageFiles({
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
      previewBundle: (bundle) => skills.previewZip(bundle),
      importBundle: (bundle, items) => skills.importFromZipBatch(bundle, items),
      requestApproval: (request) => broker.request(request),
      onSkillsChanged
    })

    const result = await importer.request({
      sessionId: 'session-1',
      attachmentUri: pathToFileURL(attachment.path).href
    })

    expect(result).toEqual({
      status: 'imported',
      skills: [{ id: 'imported-paper-finder', name: 'Paper Finder', status: 'imported' }]
    })
    expect((await skills.list()).map((skill) => skill.name)).toEqual(['Paper Finder'])
    expect(onSkillsChanged).toHaveBeenCalledOnce()
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
    const [staged] = await uploads.stageFiles({
      files: [{ name: 'private.skill', content: zip.toString('base64') }]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-2', [staged])
    const requestApproval = vi.fn()
    const importer = new ConversationSkillImporter({
      uploads,
      previewBundle: (bundle) => skills.previewZip(bundle),
      importBundle: (bundle, items) => skills.importFromZipBatch(bundle, items),
      requestApproval
    })

    await expect(
      importer.request({
        sessionId: 'session-1',
        attachmentUri: pathToFileURL(attachment.path).href
      })
    ).rejects.toThrow('different session')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('rejects two approved candidates that replace the same installed Skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const uploads = new UploadRepository(root)
    const [staged] = await uploads.stageFiles({
      files: [
        {
          name: 'duplicate-targets.skill',
          content: Buffer.from('bundle contents').toString('base64'),
          mimeType: 'application/zip'
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-1', [staged])
    const importBundle = vi.fn().mockResolvedValue([])
    const importer = new ConversationSkillImporter({
      uploads,
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
        attachmentUri: pathToFileURL(attachment.path).href
      })
    ).rejects.toThrow('cannot replace the same installed Skill more than once')
    expect(importBundle).not.toHaveBeenCalled()
  })

  it('rejects an approval that drops the previewed replacement target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-skill-import-'))
    roots.push(root)
    const uploads = new UploadRepository(root)
    const [staged] = await uploads.stageFiles({
      files: [
        {
          name: 'replacement.skill',
          content: Buffer.from('bundle contents').toString('base64'),
          mimeType: 'application/zip'
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-1', [staged])
    const importBundle = vi.fn().mockResolvedValue([])
    const importer = new ConversationSkillImporter({
      uploads,
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
