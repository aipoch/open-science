import type { ContentBlock } from '@agentclientprotocol/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UploadedAttachment } from '../../shared/uploads'
import { estimateHistoryTokens } from '../../shared/history-preamble'
import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import { createManagedFileReferenceResolver } from './file-reference-resolver'
import { AcpPromptContentOwner } from './prompt-content-owner'

const roots: string[] = []

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'acp-prompt-content-owner-'))
  roots.push(root)
  return root
}

const contentBlocks = (content: string | ContentBlock[]): ContentBlock[] => {
  expect(Array.isArray(content)).toBe(true)
  return content as ContentBlock[]
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AcpPromptContentOwner', () => {
  it('keeps the text fast path isolated from ambient resolvers and defensively owns Codex metadata', async () => {
    const resolver = createManagedFileReferenceResolver({})
    const resolveReference = vi.spyOn(resolver, 'resolve')
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: resolver,
      inlineImageBudgetBytes: 1_024
    })
    const onSkillImportAttachmentEligible = vi.fn()

    const plain = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'default-project',
      text: '  plain text is preserved  ',
      historyImages: [],
      historyUploads: [],
      currentUploads: [],
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false,
      skillImportTurnToken: undefined,
      onSkillImportAttachmentEligible
    })

    expect(plain).toEqual({ content: '  plain text is preserved  ' })
    expect(resolveReference).not.toHaveBeenCalled()
    expect(onSkillImportAttachmentEligible).not.toHaveBeenCalled()

    const codexSkillInputs = [{ name: 'research', path: '/skills/research/SKILL.md' }]
    const withCodexMetadata = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'default-project',
      text: 'use the selected Skill',
      historyImages: [],
      historyUploads: [],
      currentUploads: [],
      references: [],
      codexSkillInputs,
      skillImportEnabled: false,
      skillImportTurnToken: undefined,
      onSkillImportAttachmentEligible
    })

    codexSkillInputs[0].name = 'mutated-after-prepare'
    codexSkillInputs.push({ name: 'late', path: '/skills/late/SKILL.md' })
    expect(withCodexMetadata).toEqual({
      content: [
        {
          type: 'text',
          text: 'use the selected Skill',
          _meta: {
            'open-science/skill-inputs': [{ name: 'research', path: '/skills/research/SKILL.md' }]
          }
        }
      ]
    })
    expect(resolveReference).not.toHaveBeenCalled()
  })

  it('preserves combined block order and returns the exact registered turn inputs', async () => {
    const root = await createRoot()
    const uploads = new UploadRepository(root)
    const [referencePending] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'referenced.txt',
          mimeType: 'text/plain',
          content: Buffer.from('referenced body').toString('base64')
        }
      ]
    })
    const [referencedUpload] = await uploads.finalizePendingSessionUploads(
      'source-session',
      [referencePending],
      'default-project'
    )
    const [historyPending] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'history.txt',
          mimeType: 'text/plain',
          content: Buffer.from('history body').toString('base64')
        }
      ]
    })
    const [historyUpload] = await uploads.finalizePendingSessionUploads(
      'source-session',
      [historyPending],
      'default-project'
    )
    const immutableHistoryUpload = { ...historyUpload, versionId: 'history-version-1' }
    const [currentUpload] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'current.txt',
          mimeType: 'text/plain',
          content: Buffer.from('current body').toString('base64')
        }
      ]
    })
    const reference = {
      id: referencedUpload.id,
      name: referencedUpload.originalName,
      path: referencedUpload.path,
      source: 'upload' as const,
      mimeType: referencedUpload.mimeType
    }
    const owner = new AcpPromptContentOwner({
      uploadRepository: uploads,
      fileReferenceResolver: createManagedFileReferenceResolver({ uploads }),
      inlineImageBudgetBytes: 1_024
    })
    const finalizeUploads = vi.spyOn(uploads, 'finalizePendingSessionUploads')

    const result = await owner.prepare({
      appSessionId: 'target-session',
      projectId: 'default-project',
      text: 'combined prompt',
      historyImages: [
        {
          mimeType: 'image/png',
          data: Buffer.from('history-image').toString('base64'),
          byteLength: Buffer.byteLength('history-image')
        }
      ],
      historyUploads: [immutableHistoryUpload],
      currentUploads: [currentUpload],
      references: [reference],
      codexSkillInputs: [],
      skillImportEnabled: false,
      skillImportTurnToken: undefined,
      onSkillImportAttachmentEligible: vi.fn()
    })

    const blocks = contentBlocks(result.content)
    expect(blocks.map((block) => block.type)).toEqual([
      'text',
      'image',
      'resource_link',
      'resource',
      'resource'
    ])
    expect(blocks[0]).toEqual({ type: 'text', text: 'combined prompt' })
    expect(blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(blocks[2]).toMatchObject({ type: 'resource_link', name: 'history.txt' })
    expect(blocks[3]).toMatchObject({
      type: 'resource',
      resource: { text: 'current body' }
    })
    expect(blocks[4]).toMatchObject({
      type: 'resource',
      resource: { text: 'referenced body' }
    })
    expect(result.turnInputs?.uploads.map((upload) => upload.originalName)).toEqual([
      'history.txt',
      'current.txt'
    ])
    expect(result.turnInputs?.uploads.map((upload) => upload.sessionId)).toEqual([
      'source-session',
      'target-session'
    ])
    expect(finalizeUploads).toHaveBeenCalledOnce()
    expect(finalizeUploads).toHaveBeenCalledWith(
      'target-session',
      [currentUpload],
      'default-project'
    )
    expect(result.turnInputs?.references).toEqual([reference])
  })

  it('shares one text budget across current files and keeps both ends of prose previews', async () => {
    const root = await createRoot()
    const uploads = new UploadRepository(root)
    const staged = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'one.txt',
          mimeType: 'text/plain',
          content: Buffer.from(`BEGIN-ONE\n${'a'.repeat(4_000)}\nEND-ONE`).toString('base64')
        },
        {
          name: 'two.txt',
          mimeType: 'text/plain',
          content: Buffer.from(`BEGIN-TWO\n${'b'.repeat(4_000)}\nEND-TWO`).toString('base64')
        }
      ]
    })
    const owner = new AcpPromptContentOwner({
      uploadRepository: uploads,
      fileReferenceResolver: createManagedFileReferenceResolver({ uploads })
    })

    const result = await owner.prepare({
      appSessionId: 'target-session',
      projectId: 'default-project',
      text: 'compare these files',
      historyImages: [],
      historyUploads: [],
      currentUploads: staged,
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false,
      fileTextBudget: 2_000
    })

    const fileText = contentBlocks(result.content)
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .slice(1)
      .map((block) => block.text)
    expect(fileText).toHaveLength(2)
    expect(fileText.join('\n')).toContain('BEGIN-ONE')
    expect(fileText.join('\n')).toContain('END-ONE')
    expect(fileText.join('\n')).toContain('BEGIN-TWO')
    expect(fileText.join('\n')).toContain('END-TWO')
    expect(
      fileText.reduce((total, text) => total + estimateHistoryTokens(text), 0)
    ).toBeLessThanOrEqual(2_000)
    expect(fileText.join('\n')).not.toContain('a'.repeat(1_000))
    expect(fileText.join('\n')).not.toContain('b'.repeat(1_000))
  })

  it('finalizes a genuinely staged history upload for the target Session', async () => {
    const root = await createRoot()
    const uploads = new UploadRepository(root)
    const [stagedHistory] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'history.txt',
          mimeType: 'text/plain',
          content: Buffer.from('history body').toString('base64')
        }
      ]
    })
    const owner = new AcpPromptContentOwner({
      uploadRepository: uploads,
      fileReferenceResolver: createManagedFileReferenceResolver({ uploads })
    })

    const result = await owner.prepare({
      appSessionId: 'target-session',
      projectId: 'default-project',
      text: 'continue',
      historyImages: [],
      historyUploads: [stagedHistory],
      currentUploads: [],
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false
    })

    expect(result.turnInputs).toBeUndefined()
    expect(contentBlocks(result.content)).toContainEqual(
      expect.objectContaining({ type: 'resource_link', name: 'history.txt' })
    )
  })

  it('resolves source-owned legacy history without re-finalizing it for the target Session', async () => {
    const root = await createRoot()
    const uploads = new UploadRepository(root)
    const [stagedHistory] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'history.txt',
          mimeType: 'text/plain',
          content: Buffer.from('history body').toString('base64')
        }
      ]
    })
    const [legacyHistory] = await uploads.finalizePendingSessionUploads(
      'source-session',
      [stagedHistory],
      'default-project'
    )
    const finalizeUploads = vi.spyOn(uploads, 'finalizePendingSessionUploads')
    const owner = new AcpPromptContentOwner({
      uploadRepository: uploads,
      fileReferenceResolver: createManagedFileReferenceResolver({ uploads })
    })

    const result = await owner.prepare({
      appSessionId: 'target-session',
      projectId: 'default-project',
      text: 'continue',
      historyImages: [],
      historyUploads: [{ ...legacyHistory, versionId: undefined }],
      currentUploads: [],
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false
    })

    expect(contentBlocks(result.content)).toContainEqual(
      expect.objectContaining({ type: 'resource_link', name: 'history.txt' })
    )
    expect(result.turnInputs).toBeUndefined()
    expect(finalizeUploads).not.toHaveBeenCalled()
  })

  it('owns cumulative image budget per Session and releases it on resetSession and clear', async () => {
    const root = await createRoot()
    const uploads = new UploadRepository(root)
    const owner = new AcpPromptContentOwner({
      uploadRepository: uploads,
      fileReferenceResolver: createManagedFileReferenceResolver({ uploads }),
      inlineImageBudgetBytes: 15
    })
    const stageImage = async (name: string): Promise<UploadedAttachment> => {
      const [image] = await stageUploadFixtures(uploads, {
        files: [
          {
            name,
            mimeType: 'image/png',
            content: Buffer.from('png-bytes').toString('base64')
          }
        ]
      })
      return image
    }
    const prepareImage = async (name: string): ReturnType<AcpPromptContentOwner['prepare']> =>
      owner.prepare({
        appSessionId: 'session-1',
        projectId: 'default-project',
        text: name,
        historyImages: [],
        historyUploads: [],
        currentUploads: [await stageImage(name)],
        references: [],
        codexSkillInputs: [],
        skillImportEnabled: false,
        skillImportTurnToken: undefined,
        onSkillImportAttachmentEligible: vi.fn()
      })

    const first = await prepareImage('first.png')
    const overBudget = await prepareImage('over-budget.png')
    expect(contentBlocks(first.content).at(-1)?.type).toBe('image')
    expect(contentBlocks(overBudget.content).at(-1)?.type).toBe('resource_link')

    owner.resetSession('session-1')
    const afterReset = await prepareImage('after-reset.png')
    expect(contentBlocks(afterReset.content).at(-1)?.type).toBe('image')

    owner.clear()
    const afterClear = await prepareImage('after-clear.png')
    expect(contentBlocks(afterClear.content).at(-1)?.type).toBe('image')
  })

  it('keeps already-processed image bytes charged when a later reference rejects', async () => {
    const root = await createRoot()
    const uploads = new UploadRepository(root)
    const owner = new AcpPromptContentOwner({
      uploadRepository: uploads,
      fileReferenceResolver: createManagedFileReferenceResolver({ uploads }),
      inlineImageBudgetBytes: 15
    })
    const stageImage = async (name: string): Promise<UploadedAttachment> => {
      const [image] = await stageUploadFixtures(uploads, {
        files: [
          {
            name,
            mimeType: 'image/png',
            content: Buffer.from('png-bytes').toString('base64')
          }
        ]
      })
      return image
    }

    await expect(
      owner.prepare({
        appSessionId: 'session-1',
        projectId: 'default-project',
        text: 'fails after image processing',
        historyImages: [],
        historyUploads: [],
        currentUploads: [await stageImage('charged.png')],
        references: [
          {
            id: 'linked-1',
            name: 'unavailable.txt',
            source: 'linked-folder',
            rootId: 'unconfigured-root',
            relativePath: 'unavailable.txt'
          }
        ],
        codexSkillInputs: [],
        skillImportEnabled: false,
        skillImportTurnToken: undefined,
        onSkillImportAttachmentEligible: vi.fn()
      })
    ).rejects.toThrow(/not configured/i)

    const afterFailure = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'default-project',
      text: 'next image',
      historyImages: [],
      historyUploads: [],
      currentUploads: [await stageImage('after-failure.png')],
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false,
      skillImportTurnToken: undefined,
      onSkillImportAttachmentEligible: vi.fn()
    })

    expect(contentBlocks(afterFailure.content).at(-1)?.type).toBe('resource_link')
  })
})
