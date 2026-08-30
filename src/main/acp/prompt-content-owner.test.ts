import type { ContentBlock } from '@agentclientprotocol/sdk'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UploadedAttachment } from '../../shared/uploads'
import { MAX_ACP_MESSAGE_IMAGE_BYTES } from '../../shared/acp'
import { estimateHistoryTokens } from '../../shared/history-preamble'
import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import { extractPdfText, MAX_AUTO_PROCESS_IMAGE_BYTES } from '../uploads/attachment-media'
import { createManagedFileReferenceResolver } from './file-reference-resolver'
import { AcpPromptContentOwner, resolvePdfPreparationScope } from './prompt-content-owner'

const { loggerInfo } = vi.hoisted(() => ({ loggerInfo: vi.fn() }))

vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: loggerInfo,
      warn: vi.fn(),
      error: vi.fn()
    })
  }
})

vi.mock('../uploads/attachment-media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../uploads/attachment-media')>()
  return { ...actual, extractPdfText: vi.fn(actual.extractPdfText) }
})

const roots: string[] = []

describe('PDF preparation routing', () => {
  it.each([
    ['总结一下整篇论文的核心贡献。', 'full-document'],
    ['解读文献', 'full-document'],
    ['梳理这篇论文的核心贡献和实验。', 'full-document'],
    ['分析这项研究的方法、结果和局限。', 'full-document'],
    ['提炼整篇文章的研究问题、方法与结论。', 'full-document'],
    ['Give me an overview of this paper.', 'full-document'],
    ["Walk me through the paper's methods, results, and limitations.", 'full-document'],
    ["Analyze this paper's contributions and experiments.", 'full-document'],
    ['解释这里为什么使用 BM25。', 'current-page'],
    ['What am I looking at?', 'current-page'],
    ['这个方法有哪些局限？', 'auto'],
    ['How does the evaluator work?', 'auto'],
    ['Compare the evaluator with a reranker.', 'auto']
  ] as const)('routes %s to %s', (text, expected) => {
    expect(resolvePdfPreparationScope(text, { pageNumber: 4, pageCount: 12 })).toBe(expected)
  })

  it('does not select current-page routing without a captured reading position', () => {
    expect(resolvePdfPreparationScope('解释这里。', undefined)).toBe('auto')
  })
})

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
  it('injects the send-time PDF page snapshot instead of a document-prefix preview', async () => {
    const root = await createRoot()
    const sourcePath = join(root, 'paper.pdf')
    await writeFile(sourcePath, '%PDF-1.4 fake')
    vi.mocked(extractPdfText).mockResolvedValueOnce({
      text: '--- Page 2 ---\nVisible page\n--- Page 3 ---\nQuoted marker remains on page 2',
      pageCount: 3,
      truncated: false
    })
    const resolver = createManagedFileReferenceResolver({})
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      absolutePath: sourcePath,
      uri: pathToFileURL(sourcePath).href,
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 14,
      allowSkillImportReference: false
    })
    const owner = new AcpPromptContentOwner({ fileReferenceResolver: resolver })

    const prepared = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'project-1',
      text: '我在看第几页？',
      historyImages: [],
      historyUploads: [],
      currentUploads: [],
      references: [
        {
          id: 'artifact-1',
          name: 'paper.pdf',
          source: 'artifact',
          path: 'artifact-version:project-1/source-session/artifact-1/version-1',
          versionId: 'version-1',
          mimeType: 'application/pdf',
          pdfReadingPosition: { pageNumber: 2, pageCount: 3 }
        }
      ],
      codexSkillInputs: [],
      skillImportEnabled: false
    })

    const pdf = contentBlocks(prepared.content).find((block) => block.type === 'resource')
    expect(extractPdfText).toHaveBeenCalledWith(sourcePath, 2)
    expect(pdf).toMatchObject({
      type: 'resource',
      resource: {
        text: expect.stringContaining('"pageNumber":2,"pageCount":3,"capturedAtSend":true')
      }
    })
    if (pdf?.type === 'resource' && 'text' in pdf.resource) {
      expect(pdf.resource.text).toContain('--- Page 2 ---\nVisible page')
      expect(pdf.resource.text).toContain('--- Page 3 ---\nQuoted marker remains on page 2')
    }
  })

  it('uses document context for a document-wide question despite a visible PDF page', async () => {
    const root = await createRoot()
    const sourcePath = join(root, 'paper.pdf')
    await writeFile(sourcePath, '%PDF-1.4 fake')
    const extractedDocument = {
      text: '--- Page 1 ---\nFirst page\n\n--- Page 2 ---\nSecond page\n\n--- Page 3 ---\nLast page',
      pageCount: 3,
      truncated: false
    }
    vi.mocked(extractPdfText).mockResolvedValue(extractedDocument)
    const resolver = createManagedFileReferenceResolver({})
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      absolutePath: sourcePath,
      uri: pathToFileURL(sourcePath).href,
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 14,
      allowSkillImportReference: false
    })
    const owner = new AcpPromptContentOwner({ fileReferenceResolver: resolver })
    loggerInfo.mockClear()
    const extractionCallStart = vi.mocked(extractPdfText).mock.calls.length
    const prepare = (text: string): ReturnType<AcpPromptContentOwner['prepare']> =>
      owner.prepare({
        appSessionId: 'session-1',
        projectId: 'project-1',
        text,
        historyImages: [],
        historyUploads: [],
        currentUploads: [],
        references: [
          {
            id: 'artifact-1',
            name: 'paper.pdf',
            source: 'artifact',
            path: 'artifact-version:project-1/source-session/artifact-1/version-1',
            versionId: 'version-1',
            mimeType: 'application/pdf',
            pdfContextDocumentId: 'binding-1',
            pdfContextDocumentCount: 2,
            pdfContextActive: true,
            pdfReadingPosition: { pageNumber: 2, pageCount: 3 }
          }
        ],
        codexSkillInputs: [],
        skillImportEnabled: false
      })

    try {
      const prepared = await prepare('总结一下整篇论文的核心贡献。')
      await prepare('这个方法有哪些局限？')
      const overall = await prepare("Analyze this paper's overall results and contributions.")

      expect(vi.mocked(extractPdfText).mock.calls.slice(extractionCallStart)).toEqual([])
      const pdf = contentBlocks(prepared.content).find(
        (block) => block.type === 'text' && block.text.includes('route":"literature-mcp')
      )
      expect(pdf).toMatchObject({
        type: 'text',
        text: expect.stringContaining('route":"literature-mcp')
      })
      expect(pdf).toMatchObject({
        type: 'text',
        text: expect.stringContaining('`read_document`')
      })
      expect(
        contentBlocks(overall.content).find(
          (block) => block.type === 'text' && block.text.includes('route":"literature-mcp')
        )
      ).toMatchObject({
        type: 'text',
        text: expect.stringContaining('"target":"active-document"')
      })
      expect(loggerInfo.mock.calls.map(([, fields]) => fields)).toEqual([
        expect.objectContaining({
          retrievalMode: 'literature-tool',
          scope: 'full-document',
          routingReason: 'intent-full-document',
          fullDocumentInjected: false,
          bm25Status: 'not-requested'
        }),
        expect.objectContaining({
          retrievalMode: 'literature-tool',
          scope: 'auto',
          routingReason: 'intent-auto',
          fullDocumentInjected: false,
          bm25Status: 'pending-read-document-query'
        }),
        expect.objectContaining({
          retrievalMode: 'literature-tool',
          scope: 'full-document',
          routingReason: 'intent-full-document',
          fullDocumentInjected: false,
          bm25Status: 'not-requested'
        })
      ])
      expect(JSON.stringify(loggerInfo.mock.calls)).not.toContain('paper.pdf')
    } finally {
      loggerInfo.mockClear()
    }
  })

  it('sends a read-only linked file from its disposable snapshot URI', async () => {
    const root = await createRoot()
    const sourcePath = join(root, 'study.csv')
    await writeFile(sourcePath, 'id,value\n1,2\n')
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRoot: async () => ({ path: root, access: 'ro' }) }
    })
    const resolveReference = vi.spyOn(resolver, 'resolve')
    const owner = new AcpPromptContentOwner({ fileReferenceResolver: resolver })

    const prepared = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'default-project',
      connectionGeneration: 2,
      text: 'analyze this file',
      historyImages: [],
      historyUploads: [],
      currentUploads: [],
      references: [
        {
          id: 'linked-1',
          name: 'study.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'study.csv',
          mimeType: 'text/csv'
        }
      ],
      codexSkillInputs: [],
      skillImportEnabled: false
    })

    const resource = contentBlocks(prepared.content).find((block) => block.type === 'resource')
    expect(resource).toMatchObject({
      type: 'resource',
      resource: { text: 'id,value\n1,2\n' }
    })
    if (resource?.type === 'resource') {
      expect(resource.resource.uri).not.toBe(pathToFileURL(sourcePath).href)
    }
    expect(resolveReference).toHaveBeenCalledWith(
      expect.objectContaining({ connectionGeneration: 2 }),
      expect.anything()
    )
    owner.clear()
  })

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

    expect(plain).toEqual({ content: '  plain text is preserved  ', historyImageCount: 0 })
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
      ],
      historyImageCount: 0
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
    expect(result.historyImageCount).toBe(1)
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

  it('keeps current images out of the replay image count', async () => {
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: createManagedFileReferenceResolver({})
    })
    const historyData = Buffer.from('history-image').toString('base64')
    const currentData = Buffer.from('current-image').toString('base64')

    const result = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'project-1',
      text: 'compare these images',
      historyImages: [
        {
          mimeType: 'image/png',
          data: historyData,
          byteLength: Buffer.byteLength('history-image')
        }
      ],
      currentImages: [
        {
          mimeType: 'image/png',
          data: currentData,
          byteLength: Buffer.byteLength('current-image')
        }
      ],
      historyUploads: [],
      currentUploads: [],
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false
    })

    expect(result.historyImageCount).toBe(1)
    expect(contentBlocks(result.content)).toMatchObject([
      { type: 'text', text: 'compare these images' },
      { type: 'image', data: historyData },
      { type: 'image', data: currentData }
    ])
  })

  it('rejects invalid current images at the main prompt boundary', async () => {
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: createManagedFileReferenceResolver({})
    })

    await expect(
      owner.prepare({
        appSessionId: 'session-1',
        projectId: 'project-1',
        text: 'inspect this region',
        historyImages: [],
        currentImages: [{ mimeType: 'image/png', data: 'not base64', byteLength: 10 }],
        historyUploads: [],
        currentUploads: [],
        references: [],
        codexSkillInputs: [],
        skillImportEnabled: false
      })
    ).rejects.toThrow(/invalid current image/i)
  })

  it('rejects current images above the shared per-message count', async () => {
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: createManagedFileReferenceResolver({})
    })
    const data = Buffer.from('image').toString('base64')

    await expect(
      owner.prepare({
        appSessionId: 'session-1',
        projectId: 'project-1',
        text: 'inspect these regions',
        historyImages: [],
        currentImages: Array.from({ length: 5 }, () => ({
          mimeType: 'image/png' as const,
          data,
          byteLength: 5
        })),
        historyUploads: [],
        currentUploads: [],
        references: [],
        codexSkillInputs: [],
        skillImportEnabled: false
      })
    ).rejects.toThrow(/at most 4 current images/i)
  })

  it('rejects individually valid current images above the shared aggregate byte budget', async () => {
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: createManagedFileReferenceResolver({})
    })
    const maximumImageData = Buffer.alloc(MAX_ACP_MESSAGE_IMAGE_BYTES, 1).toString('base64')
    const oneByteImageData = Buffer.from([1]).toString('base64')

    await expect(
      owner.prepare({
        appSessionId: 'session-1',
        projectId: 'project-1',
        text: 'inspect these regions',
        historyImages: [],
        currentImages: [maximumImageData, maximumImageData, oneByteImageData].map((data) => ({
          mimeType: 'image/png' as const,
          data,
          byteLength: 0
        })),
        historyUploads: [],
        currentUploads: [],
        references: [],
        codexSkillInputs: [],
        skillImportEnabled: false
      })
    ).rejects.toThrow(/per-message budget/i)
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

  it('inlines a current Version owned by another Session in the same Project', async () => {
    const root = await createRoot()
    const uploads = new UploadRepository(root)
    const [staged] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'measurements.csv',
          mimeType: 'text/csv',
          content: Buffer.from('id,value\n1,2\n').toString('base64')
        }
      ]
    })
    const [sourceOwned] = await uploads.finalizePendingSessionUploads(
      'source-session',
      [staged],
      'default-project'
    )
    const currentUpload = {
      ...sourceOwned,
      versionId: 'upload-version-source',
      versionNumber: 1
    }
    const finalizeUploads = vi.spyOn(uploads, 'finalizePendingSessionUploads')
    const owner = new AcpPromptContentOwner({
      uploadRepository: uploads,
      fileReferenceResolver: createManagedFileReferenceResolver({ uploads })
    })

    const result = await owner.prepare({
      appSessionId: 'target-session',
      projectId: 'default-project',
      text: 'analyze the uploaded table',
      historyImages: [],
      historyUploads: [],
      currentUploads: [currentUpload],
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false
    })

    expect(finalizeUploads).not.toHaveBeenCalled()
    expect(contentBlocks(result.content)).toEqual([
      { type: 'text', text: 'analyze the uploaded table' },
      expect.objectContaining({
        type: 'resource',
        resource: expect.objectContaining({ text: 'id,value\n1,2\n' })
      })
    ])
    expect(result.turnInputs?.uploads.map((upload) => upload.versionId)).toEqual([
      'upload-version-source'
    ])
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

    const relay = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'default-project',
      text: 'relay.png',
      historyImages: [],
      historyUploads: [],
      currentUploads: [await stageImage('relay.png')],
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false,
      imageCompatibilityRelay: true,
      skillImportTurnToken: undefined,
      onSkillImportAttachmentEligible: vi.fn()
    })
    expect(contentBlocks(relay.content).at(-1)?.type).toBe('image')
    expect(relay.imageSources).toEqual([undefined])

    owner.resetSession('session-1')
    const afterReset = await prepareImage('after-reset.png')
    expect(contentBlocks(afterReset.content).at(-1)?.type).toBe('image')

    owner.clear()
    const afterClear = await prepareImage('after-clear.png')
    expect(contentBlocks(afterClear.content).at(-1)?.type).toBe('image')
  })

  it('leaves only a relay-owned link for an oversized historical image', async () => {
    const root = await createRoot()
    const uploads = new UploadRepository(root)
    const [pending] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'oversized.png',
          mimeType: 'image/png',
          content: Buffer.from('png').toString('base64')
        }
      ]
    })
    const [historyImage] = await uploads.finalizePendingSessionUploads(
      'session-1',
      [pending],
      'default-project'
    )
    const path = await uploads.resolveSessionUploadPath(
      'session-1',
      { path: historyImage.path },
      'default-project'
    )
    await truncate(path, MAX_AUTO_PROCESS_IMAGE_BYTES + 1)
    const owner = new AcpPromptContentOwner({
      uploadRepository: uploads,
      fileReferenceResolver: createManagedFileReferenceResolver({ uploads })
    })

    const prepared = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'default-project',
      text: 'inspect history',
      historyImages: [],
      historyUploads: [{ ...historyImage, versionId: 'history-version-1' }],
      currentUploads: [],
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false,
      imageCompatibilityRelay: true,
      skillImportTurnToken: undefined,
      onSkillImportAttachmentEligible: vi.fn()
    })

    expect(contentBlocks(prepared.content)).toEqual([
      { type: 'text', text: 'inspect history' },
      expect.objectContaining({ type: 'resource_link', name: 'oversized.png' })
    ])
    expect(prepared.imageSources).toEqual([
      { kind: 'upload-version', uploadVersionId: 'history-version-1' }
    ])
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
