import type { ContentBlock } from '@agentclientprotocol/sdk'
import { access, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAX_ACP_MESSAGE_IMAGE_BYTES } from '../../shared/acp'
import { createUploadVersionReference, type UploadedAttachment } from '../../shared/uploads'
import { estimateHistoryTokens } from '../../shared/history-preamble'
import { extractPdfText, MAX_AUTO_PROCESS_IMAGE_BYTES } from '../uploads/attachment-media'
import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import {
  createManagedFileReferenceResolver,
  FileReferenceResolver
} from './file-reference-resolver'
import { AcpPromptContentOwner, resolvePdfPreparationScope } from './prompt-content-owner'
import { TurnResourceSnapshotStore } from './turn-resource-snapshot-store'

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

type TrustedLeaseFixture = {
  size: number
  read: ReturnType<typeof vi.fn>
  readRange: ReturnType<typeof vi.fn>
  copyTo: ReturnType<typeof vi.fn>
  verifyUnchanged: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

const createTrustedLease = (bytes: Buffer): TrustedLeaseFixture => {
  const readRange = vi.fn(async (begin: number, end: number) => bytes.subarray(begin, end))
  const read = vi.fn(
    async (buffer: Uint8Array, offset: number, length: number, position: number) => {
      const chunk = bytes.subarray(position, position + length)
      buffer.set(chunk, offset)
      return { bytesRead: chunk.byteLength }
    }
  )
  const verifyUnchanged = vi.fn(async () => undefined)
  const copyTo = vi.fn(async (destinationPath: string) => {
    await writeFile(destinationPath, bytes, { flag: 'wx' })
  })
  const close = vi.fn(async () => undefined)
  return { size: bytes.byteLength, read, readRange, copyTo, verifyUnchanged, close }
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

  it('keeps resource links on a private verified snapshot until prepared content closes', async () => {
    const root = await createRoot()
    const replacedPath = join(root, 'replaced.txt')
    await writeFile(replacedPath, 'untrusted path bytes')
    const trustedBytes = Buffer.from('verified lease bytes')
    const trustedLease = createTrustedLease(trustedBytes)
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: new FileReferenceResolver([
        {
          source: 'artifact',
          resolve: async () =>
            ({
              absolutePath: replacedPath,
              name: 'notes.txt',
              mimeType: 'text/plain',
              allowSkillImportReference: false,
              sourceFileId: 'artifact-file',
              versionId: 'artifact-version-2',
              trustedLease
            }) as never
        }
      ])
    })

    const result = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'project-1',
      text: 'read this',
      historyImages: [],
      historyUploads: [],
      currentUploads: [],
      references: [
        {
          id: 'artifact-row',
          sourceFileId: 'artifact-file',
          name: 'notes.txt',
          path: 'artifact-version:stale',
          source: 'artifact'
        }
      ],
      codexSkillInputs: [],
      skillImportEnabled: false,
      fileTextBudget: 1
    })

    const resourceLink = contentBlocks(result.content).find(
      (block): block is Extract<ContentBlock, { type: 'resource_link' }> =>
        block.type === 'resource_link'
    )
    expect(resourceLink).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain' })
    const snapshotPath = fileURLToPath(resourceLink!.uri)
    expect(snapshotPath).not.toBe(replacedPath)
    await writeFile(replacedPath, 'replaced again after prepare')
    await expect(readFile(snapshotPath)).resolves.toEqual(trustedBytes)
    expect((await stat(dirname(snapshotPath))).mode & 0o777).toBe(0o700)
    expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600)
    expect(trustedLease.copyTo).toHaveBeenCalledWith(snapshotPath, { exclusive: true })
    expect(trustedLease.close).toHaveBeenCalledOnce()

    result.close()
    await expect(access(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves snapshot copy errors when lease close and cleanup also fail', async () => {
    const trustedLease = createTrustedLease(Buffer.from('verified lease bytes'))
    const copyError = new Error('snapshot copy failed')
    trustedLease.copyTo.mockRejectedValueOnce(copyError)
    trustedLease.close.mockRejectedValueOnce(new Error('lease close failed'))
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: new FileReferenceResolver([
        {
          source: 'artifact',
          resolve: async () =>
            ({
              absolutePath: '/replaced.txt',
              name: 'notes.txt',
              mimeType: 'text/plain',
              allowSkillImportReference: false,
              trustedLease
            }) as never
        }
      ])
    })

    await expect(
      owner.prepare({
        appSessionId: 'session-1',
        projectId: 'project-1',
        text: 'read this',
        historyImages: [],
        historyUploads: [],
        currentUploads: [],
        references: [
          {
            id: 'artifact-row',
            sourceFileId: 'artifact-file',
            name: 'notes.txt',
            path: 'artifact-version:stale',
            source: 'artifact'
          }
        ],
        codexSkillInputs: [],
        skillImportEnabled: false
      })
    ).rejects.toBe(copyError)
    expect(trustedLease.close).toHaveBeenCalledOnce()
  })

  it('keeps prepared-content close best-effort and idempotent when snapshot cleanup fails', async () => {
    const root = await createRoot()
    const sourcePath = join(root, 'source.txt')
    await writeFile(sourcePath, 'path bytes')
    const trustedLease = createTrustedLease(Buffer.from('verified bytes'))
    const removeDirectory = vi.fn(() => {
      throw new Error('snapshot cleanup failed')
    })
    const owner = new AcpPromptContentOwner({
      createResourceSnapshotStore: () => new TurnResourceSnapshotStore({ removeDirectory }),
      fileReferenceResolver: new FileReferenceResolver([
        {
          source: 'artifact',
          resolve: async () =>
            ({
              absolutePath: sourcePath,
              name: 'notes.txt',
              mimeType: 'text/plain',
              allowSkillImportReference: false,
              trustedLease
            }) as never
        }
      ])
    })

    const result = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'project-1',
      text: 'read this',
      historyImages: [],
      historyUploads: [],
      currentUploads: [],
      references: [
        {
          id: 'artifact-row',
          sourceFileId: 'artifact-file',
          name: 'notes.txt',
          path: 'artifact-version:stale',
          source: 'artifact'
        }
      ],
      codexSkillInputs: [],
      skillImportEnabled: false,
      fileTextBudget: 1
    })
    const resourceLink = contentBlocks(result.content).find(
      (block): block is Extract<ContentBlock, { type: 'resource_link' }> =>
        block.type === 'resource_link'
    )
    const snapshotRoot = dirname(fileURLToPath(resourceLink!.uri))

    expect(() => result.close()).not.toThrow()
    expect(() => result.close()).not.toThrow()
    expect(removeDirectory).toHaveBeenCalledOnce()
    await rm(snapshotRoot, { recursive: true, force: true })
  })

  it('consumes small managed reference text from the trusted lease and closes it', async () => {
    const root = await createRoot()
    const replacedPath = join(root, 'replaced.txt')
    await writeFile(replacedPath, 'wrong path bytes')
    const trustedBytes = Buffer.from('trusted lease bytes')
    const trustedLease = createTrustedLease(trustedBytes)
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: new FileReferenceResolver([
        {
          source: 'artifact',
          resolve: async () =>
            ({
              absolutePath: replacedPath,
              name: 'notes.txt',
              mimeType: 'text/plain',
              allowSkillImportReference: false,
              sourceFileId: 'artifact-file',
              versionId: 'artifact-version-2',
              checksum: '2'.repeat(64),
              trustedLease
            }) as never
        }
      ])
    })

    const result = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'project-1',
      text: 'read this',
      historyImages: [],
      historyUploads: [],
      currentUploads: [],
      references: [
        {
          id: 'artifact-row',
          sourceFileId: 'artifact-file',
          versionId: 'artifact-version-2',
          name: 'notes.txt',
          path: 'artifact-version:stale',
          source: 'artifact'
        }
      ],
      codexSkillInputs: [],
      skillImportEnabled: false
    })

    expect(contentBlocks(result.content)).toContainEqual({
      type: 'resource',
      resource: expect.objectContaining({ text: 'trusted lease bytes' })
    })
    expect(trustedLease.readRange).toHaveBeenCalledWith(0, trustedBytes.byteLength)
    expect(trustedLease.close).toHaveBeenCalledOnce()
    result.close()
  })

  it('builds budgeted managed text previews from trusted ranges and closes the lease', async () => {
    const root = await createRoot()
    const trustedBytes = Buffer.from(`TRUSTED-BEGIN\n${'a'.repeat(600_000)}\nTRUSTED-END`)
    const replacedPath = join(root, 'replaced-large.txt')
    await writeFile(replacedPath, Buffer.alloc(trustedBytes.byteLength, 0x78))
    const trustedLease = createTrustedLease(trustedBytes)
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: new FileReferenceResolver([
        {
          source: 'artifact',
          resolve: async () =>
            ({
              absolutePath: replacedPath,
              name: 'large.txt',
              mimeType: 'text/plain',
              allowSkillImportReference: false,
              sourceFileId: 'artifact-file',
              versionId: 'artifact-version-2',
              checksum: '2'.repeat(64),
              trustedLease
            }) as never
        }
      ])
    })

    const result = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'project-1',
      text: 'summarize this',
      historyImages: [],
      historyUploads: [],
      currentUploads: [],
      references: [
        {
          id: 'artifact-row',
          sourceFileId: 'artifact-file',
          name: 'large.txt',
          path: 'artifact-version:stale',
          source: 'artifact'
        }
      ],
      codexSkillInputs: [],
      skillImportEnabled: false,
      fileTextBudget: 2_000
    })

    const renderedText = contentBlocks(result.content)
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    expect(renderedText).toContain('TRUSTED-BEGIN')
    expect(renderedText).toContain('TRUSTED-END')
    expect(trustedLease.read.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(trustedLease.close).toHaveBeenCalledOnce()
    result.close()
  })

  it('inlines managed images from the trusted lease and closes it', async () => {
    const root = await createRoot()
    const replacedPath = join(root, 'replaced.png')
    await writeFile(replacedPath, 'wrong image bytes')
    const trustedBytes = Buffer.from('trusted image bytes')
    const trustedLease = createTrustedLease(trustedBytes)
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: new FileReferenceResolver([
        {
          source: 'artifact',
          resolve: async () =>
            ({
              absolutePath: replacedPath,
              name: 'figure.png',
              mimeType: 'image/png',
              allowSkillImportReference: false,
              trustedLease
            }) as never
        }
      ])
    })

    const result = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'project-1',
      text: 'inspect this',
      historyImages: [],
      historyUploads: [],
      currentUploads: [],
      references: [
        {
          id: 'artifact-row',
          sourceFileId: 'artifact-file',
          name: 'figure.png',
          path: 'artifact-version:stale',
          source: 'artifact',
          mimeType: 'image/png'
        }
      ],
      codexSkillInputs: [],
      skillImportEnabled: false
    })

    expect(contentBlocks(result.content)).toContainEqual({
      type: 'image',
      data: trustedBytes.toString('base64'),
      mimeType: 'image/png',
      uri: expect.any(String)
    })
    expect(trustedLease.close).toHaveBeenCalledOnce()
    result.close()
  })

  it('closes the trusted lease when automatic consumption fails', async () => {
    const trustedLease = createTrustedLease(Buffer.from('unreadable'))
    trustedLease.readRange.mockRejectedValueOnce(new Error('anchored read failed'))
    trustedLease.close.mockRejectedValueOnce(new Error('close failed'))
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: new FileReferenceResolver([
        {
          source: 'artifact',
          resolve: async () =>
            ({
              absolutePath: '/missing.txt',
              name: 'notes.txt',
              mimeType: 'text/plain',
              allowSkillImportReference: false,
              trustedLease
            }) as never
        }
      ])
    })

    await expect(
      owner.prepare({
        appSessionId: 'session-1',
        projectId: 'project-1',
        text: 'read this',
        historyImages: [],
        historyUploads: [],
        currentUploads: [],
        references: [
          {
            id: 'artifact-row',
            sourceFileId: 'artifact-file',
            name: 'notes.txt',
            path: 'artifact-version:stale',
            source: 'artifact'
          }
        ],
        codexSkillInputs: [],
        skillImportEnabled: false
      })
    ).rejects.toThrow('anchored read failed')
    expect(trustedLease.close).toHaveBeenCalledOnce()
  })

  it('registers the exact head identity resolved at Agent turn start', async () => {
    const root = await createRoot()
    const path = join(root, 'head.csv')
    await writeFile(path, 'id,value\n1,2\n')
    const owner = new AcpPromptContentOwner({
      fileReferenceResolver: new FileReferenceResolver([
        {
          source: 'artifact',
          resolve: async () => ({
            absolutePath: path,
            name: 'head.csv',
            mimeType: 'text/csv',
            allowSkillImportReference: false,
            sourceFileId: 'artifact-file',
            versionId: 'artifact-version-2',
            checksum: '2'.repeat(64)
          })
        }
      ])
    })

    const result = await owner.prepare({
      appSessionId: 'session-1',
      projectId: 'project-1',
      text: 'analyze',
      historyImages: [],
      historyUploads: [],
      currentUploads: [],
      references: [
        {
          id: 'stale-row',
          sourceFileId: 'artifact-file',
          name: 'stale.csv',
          path: 'artifact-version:stale',
          source: 'artifact'
        }
      ],
      codexSkillInputs: [],
      skillImportEnabled: false
    })

    expect(result.turnInputs?.references).toEqual([
      {
        id: 'stale-row',
        sourceFileId: 'artifact-file',
        name: 'head.csv',
        path: 'artifact-version:stale',
        source: 'artifact',
        versionId: 'artifact-version-2',
        checksum: '2'.repeat(64)
      }
    ])
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

    expect(plain).toEqual({
      content: '  plain text is preserved  ',
      historyImageCount: 0,
      close: expect.any(Function)
    })
    expect(resolveReference).not.toHaveBeenCalled()
    expect(onSkillImportAttachmentEligible).not.toHaveBeenCalled()
    plain.close()

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
      historyImageCount: 0,
      close: expect.any(Function)
    })
    withCodexMetadata.close()
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
    const referencedLease = createTrustedLease(Buffer.from('referenced body'))
    const reference = {
      id: referencedUpload.id,
      sourceFileId: referencedUpload.id,
      name: referencedUpload.originalName,
      path: referencedUpload.path,
      source: 'upload' as const,
      mimeType: referencedUpload.mimeType
    }
    const owner = new AcpPromptContentOwner({
      uploadRepository: uploads,
      fileReferenceResolver: createManagedFileReferenceResolver({
        uploads,
        managedFileVersions: {
          openLatest: vi.fn(
            async () =>
              ({
                ...referencedLease,
                path: '/managed/referenced.txt',
                logicalFile: {
                  id: referencedUpload.id,
                  displayName: referencedUpload.originalName
                },
                version: {
                  id: referencedUpload.versionId,
                  contentType: referencedUpload.mimeType,
                  checksum: referencedUpload.checksum
                }
              }) as never
          )
        } as never
      }),
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

  it('reads finalized uploads from the current managed head and registers that exact head', async () => {
    const staleAttachment: UploadedAttachment = {
      id: 'upload-file-1',
      versionId: 'upload-version-1',
      versionNumber: 1,
      sessionId: 'target-session',
      name: 'notes-v1.txt',
      originalName: 'notes.txt',
      path: createUploadVersionReference('upload-version-1', {
        projectId: 'project-1',
        sessionId: 'target-session',
        fileId: 'upload-file-1'
      }),
      mimeType: 'text/plain',
      size: 8,
      checksum: '1'.repeat(64),
      createdAt: '2026-08-23T00:00:00.000Z'
    }
    const finalizePendingSessionUploads = vi.fn(async () => [staleAttachment])
    const resolveManagedUploadPath = vi.fn(async () => {
      throw new Error('The finalized path must not be used for managed prompt reads.')
    })
    const headBytes = Buffer.from('current head bytes')
    const headLease = createTrustedLease(headBytes)
    const openLatest = vi.fn(async () => ({
      ...headLease,
      path: '/managed/upload-file-1/v2.txt',
      logicalFile: {
        source: 'upload' as const,
        id: 'upload-file-1',
        projectId: 'project-1',
        sessionId: 'target-session',
        displayName: 'notes.txt',
        currentVersionId: 'upload-version-2'
      },
      version: {
        id: 'upload-version-2',
        fileId: 'upload-file-1',
        versionNumber: 2,
        state: 'ready',
        originKind: 'user_edit',
        basedOnVersionId: 'upload-version-1',
        storageTag: 'vabc12345',
        storedFilename: 'vabc12345_notes.txt',
        writeOperationId: 'operation-2',
        contentStorageKey:
          'uploads/project-1/target-session/upload-file-1/managed-versions/vabc12345_notes.txt',
        filename: 'notes.txt',
        originalFilename: 'notes.txt',
        contentType: 'text/plain',
        sizeBytes: BigInt(headBytes.byteLength),
        checksum: '2'.repeat(64),
        createdAt: new Date('2026-08-24T00:00:00.000Z')
      },
      versionToken: 2,
      snapshot: { dev: 0n, ino: 0n, size: BigInt(headBytes.byteLength), mtimeNs: 0n }
    }))
    const owner = new AcpPromptContentOwner({
      uploadRepository: {
        finalizePendingSessionUploads,
        resolveManagedUploadPath
      } as never,
      managedFileVersions: { openLatest } as never,
      fileReferenceResolver: new FileReferenceResolver([])
    })

    const result = await owner.prepare({
      appSessionId: 'target-session',
      projectId: 'project-1',
      text: 'read this',
      historyImages: [],
      historyUploads: [],
      currentUploads: [staleAttachment],
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false
    })

    expect(openLatest).toHaveBeenCalledOnce()
    expect(openLatest).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'project-1',
      fileId: 'upload-file-1'
    })
    expect(resolveManagedUploadPath).not.toHaveBeenCalled()
    expect(contentBlocks(result.content)).toContainEqual({
      type: 'resource',
      resource: expect.objectContaining({ text: 'current head bytes' })
    })
    expect(result.turnInputs?.uploads).toEqual([
      {
        id: 'upload-file-1',
        versionId: 'upload-version-2',
        versionNumber: 2,
        sessionId: 'target-session',
        name: 'notes.txt',
        originalName: 'notes.txt',
        path: createUploadVersionReference('upload-version-2', {
          projectId: 'project-1',
          sessionId: 'target-session',
          fileId: 'upload-file-1'
        }),
        mimeType: 'text/plain',
        size: headBytes.byteLength,
        checksum: '2'.repeat(64),
        createdAt: '2026-08-24T00:00:00.000Z'
      }
    ])
    expect(headLease.close).toHaveBeenCalledOnce()
    result.close()
  })

  it('keeps managed upload links on a verified turn snapshot until prepared content closes', async () => {
    const root = await createRoot()
    const managedPath = join(root, 'vabc12345_notes.txt')
    await writeFile(managedPath, 'untrusted path bytes')
    const headBytes = Buffer.from('verified current head bytes')
    const headLease = createTrustedLease(headBytes)
    const staleAttachment: UploadedAttachment = {
      id: 'upload-file-1',
      versionId: 'upload-version-1',
      versionNumber: 1,
      sessionId: 'target-session',
      name: 'notes.txt',
      originalName: 'notes.txt',
      path: createUploadVersionReference('upload-version-1', {
        projectId: 'project-1',
        sessionId: 'target-session',
        fileId: 'upload-file-1'
      }),
      mimeType: 'text/plain',
      size: 8,
      checksum: '1'.repeat(64),
      createdAt: '2026-08-23T00:00:00.000Z'
    }
    const openLatest = vi.fn(async () => ({
      ...headLease,
      path: managedPath,
      logicalFile: {
        source: 'upload' as const,
        id: 'upload-file-1',
        projectId: 'project-1',
        sessionId: 'target-session',
        displayName: 'notes.txt',
        currentVersionId: 'upload-version-2'
      },
      version: {
        id: 'upload-version-2',
        fileId: 'upload-file-1',
        versionNumber: 2,
        state: 'ready',
        originKind: 'user_edit',
        basedOnVersionId: 'upload-version-1',
        storageTag: 'vabc12345',
        storedFilename: 'vabc12345_notes.txt',
        writeOperationId: 'operation-2',
        contentStorageKey:
          'uploads/project-1/target-session/upload-file-1/managed-versions/vabc12345_notes.txt',
        filename: 'notes.txt',
        originalFilename: 'notes.txt',
        contentType: 'text/plain',
        sizeBytes: BigInt(headBytes.byteLength),
        checksum: '2'.repeat(64),
        createdAt: new Date('2026-08-24T00:00:00.000Z')
      },
      versionToken: 2,
      snapshot: { dev: 0n, ino: 0n, size: BigInt(headBytes.byteLength), mtimeNs: 0n }
    }))
    const owner = new AcpPromptContentOwner({
      uploadRepository: {
        finalizePendingSessionUploads: vi.fn(async () => [staleAttachment]),
        resolveManagedUploadPath: vi.fn()
      } as never,
      managedFileVersions: { openLatest } as never,
      fileReferenceResolver: new FileReferenceResolver([])
    })

    const prepared = await owner.prepare({
      appSessionId: 'target-session',
      projectId: 'project-1',
      text: 'read this',
      historyImages: [],
      historyUploads: [],
      currentUploads: [staleAttachment],
      references: [],
      codexSkillInputs: [],
      skillImportEnabled: false,
      fileTextBudget: 1
    })

    const resourceLink = contentBlocks(prepared.content).find(
      (block): block is Extract<ContentBlock, { type: 'resource_link' }> =>
        block.type === 'resource_link'
    )
    expect(resourceLink).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain' })
    const snapshotPath = fileURLToPath(resourceLink!.uri)
    expect(snapshotPath).not.toBe(managedPath)
    await writeFile(managedPath, 'replaced after prepare')
    await expect(readFile(snapshotPath)).resolves.toEqual(headBytes)
    expect(headLease.copyTo).toHaveBeenCalledWith(snapshotPath, { exclusive: true })
    expect(headLease.close).toHaveBeenCalledOnce()

    prepared.close()
    await expect(access(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a managed upload snapshot error when lease close also fails', async () => {
    const copyError = new Error('managed upload snapshot failed')
    const headLease = createTrustedLease(Buffer.from('verified bytes'))
    headLease.copyTo.mockRejectedValueOnce(copyError)
    headLease.close.mockRejectedValueOnce(new Error('lease close failed'))
    const attachment: UploadedAttachment = {
      id: 'upload-file-1',
      versionId: 'upload-version-1',
      versionNumber: 1,
      sessionId: 'session-1',
      name: 'notes.txt',
      originalName: 'notes.txt',
      path: 'upload-version:stale',
      mimeType: 'text/plain',
      size: 1,
      checksum: '1'.repeat(64),
      createdAt: '2026-08-23T00:00:00.000Z'
    }
    const owner = new AcpPromptContentOwner({
      uploadRepository: {
        finalizePendingSessionUploads: vi.fn(async () => [attachment])
      } as never,
      managedFileVersions: {
        openLatest: vi.fn(async () => ({
          ...headLease,
          path: '/managed/v2_notes.txt',
          logicalFile: {
            source: 'upload' as const,
            id: 'upload-file-1',
            projectId: 'project-1',
            sessionId: 'session-1',
            displayName: 'notes.txt',
            currentVersionId: 'upload-version-2'
          },
          version: {
            id: 'upload-version-2',
            fileId: 'upload-file-1',
            versionNumber: 2,
            state: 'ready',
            originKind: 'user_edit',
            basedOnVersionId: 'upload-version-1',
            storageTag: 'vabc12345',
            storedFilename: 'vabc12345_notes.txt',
            writeOperationId: 'operation-2',
            contentStorageKey:
              'uploads/project-1/session-1/upload-file-1/managed-versions/vabc12345_notes.txt',
            filename: 'notes.txt',
            originalFilename: 'notes.txt',
            contentType: 'text/plain',
            sizeBytes: BigInt(headLease.size),
            checksum: '2'.repeat(64),
            createdAt: new Date('2026-08-24T00:00:00.000Z')
          },
          versionToken: 2,
          snapshot: { dev: 0n, ino: 0n, size: BigInt(headLease.size), mtimeNs: 0n }
        }))
      } as never,
      fileReferenceResolver: new FileReferenceResolver([])
    })

    await expect(
      owner.prepare({
        appSessionId: 'session-1',
        projectId: 'project-1',
        text: 'read this',
        historyImages: [],
        historyUploads: [],
        currentUploads: [attachment],
        references: [],
        codexSkillInputs: [],
        skillImportEnabled: false
      })
    ).rejects.toBe(copyError)
    expect(headLease.close).toHaveBeenCalledOnce()
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
