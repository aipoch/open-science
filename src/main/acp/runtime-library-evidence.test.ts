import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { claudeCodeFramework, codexFramework, opencodeFramework } from '../agent-framework'
import type { AgentMcpHttpHost } from './mcp-http-host'
import type { AcpSessionInteractionScope } from './session-interaction-owner'
import { CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY } from './session-capability-owner'
import type { LiteratureLibraryMcpHandler } from '../literature/library-mcp-server'
import { LiteratureDocumentReader } from '../literature/document-reader'
import { extractPdfText } from '../uploads/attachment-media'

vi.mock('../uploads/attachment-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../uploads/attachment-media')>()),
  extractPdfText: vi.fn()
}))

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.clearAllMocks()
})

const setup = async (
  library: Pick<LiteratureLibraryMcpHandler, 'searchLibrary' | 'readPdf'> &
    Partial<Pick<LiteratureLibraryMcpHandler, 'readAbstract'>>,
  framework = claudeCodeFramework,
  bridge = false
): Promise<{
  root: string
  owners: ReturnType<typeof composeAcpRuntimeBaseOwners>
  interaction: AcpSessionInteractionScope
  handler: LiteratureLibraryMcpHandler
  recordLiteratureAbstractRead: ReturnType<typeof vi.fn>
  recordLiteratureSearch: ReturnType<typeof vi.fn>
  recordLiteraturePdfRead: ReturnType<typeof vi.fn>
}> => {
  const root = await mkdtemp(join(tmpdir(), 'literature-runtime-evidence-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let handler!: LiteratureLibraryMcpHandler
  const recordLiteratureAbstractRead = vi.fn()
  const recordLiteratureSearch = vi.fn()
  const recordLiteraturePdfRead = vi.fn()
  const owners = composeAcpRuntimeBaseOwners({
    appVersion: 'test',
    defaultCwd: root,
    mcpHttpHost: {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
      registerArtifact: vi.fn(),
      registerLiteratureLibrary: vi.fn((_id: string, registered: LiteratureLibraryMcpHandler) => {
        handler = registered
      }),
      urlFor: vi.fn((kind: string, id: string) => `http://127.0.0.1:5/${kind}/${id}`),
      unregister: vi.fn(),
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost,
    artifacts: {
      configRoot: root,
      dataRoot: root,
      projectId: 'project-1',
      mcpEntryPath: join(root, 'mcp'),
      provenance: {
        recordLiteratureSearch,
        recordLiteraturePdfRead,
        recordLiteratureAbstractRead
      } as never
    },
    literatureLibrary: { readAbstract: vi.fn(), saveToInbox: vi.fn(), ...library }
  })
  const provision = await owners.sessionCapabilities.provision({
    stableAppSessionId: 'session-1',
    framework,
    nativeMcpEnabled: !bridge,
    bridgeMcpAliasesEnabled: bridge,
    policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
    sessionCwd: root,
    projectId: 'project-1'
  })
  cleanup.push(() => provision.release({ ownsStableIdentity: true }))
  cleanup.push(() => owners.sessionInteractions.supersedeAll())
  const interaction = owners.sessionInteractions.claim({
    sessionId: 'session-1',
    kind: 'prompt',
    promptMessageId: 'message-1'
  })
  return {
    root,
    owners,
    interaction,
    handler,
    recordLiteratureSearch,
    recordLiteraturePdfRead,
    recordLiteratureAbstractRead
  }
}

describe('Runtime Library evidence ownership', () => {
  it('does not attribute delayed search or PDF evidence to a replacement prompt', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const result = { items: [], totalCount: 0, hasMore: false }
    const pdf = {
      itemTitle: 'Original paper',
      evidence: { scope: 'relevant-passages', passages: [{ content: 'Original findings.' }] }
    }
    const { handler, owners, interaction, recordLiteratureSearch, recordLiteraturePdfRead } =
      await setup({
        searchLibrary: async () => {
          await pending
          return result
        },
        readPdf: async () => {
          await pending
          return pdf
        }
      })
    const search = handler.searchLibrary({ query: 'original question', scope: 'project' })
    const read = handler.readPdf({ itemId: 'original-item', query: 'original findings' })
    owners.sessionInteractions.supersede(interaction)
    const replacement = owners.sessionInteractions.claim({
      sessionId: 'session-1',
      kind: 'prompt',
      promptMessageId: 'message-2'
    })
    expect(interaction.signal.aborted).toBe(true)
    expect(owners.sessionInteractions.current('session-1')).toBe(replacement)
    finish()
    await Promise.all([search, read])
    // Either discard cancelled results or retain their original owner; never relabel them.
    expect
      .soft(recordLiteratureSearch.mock.calls.map(([request]) => request.promptMessageId))
      .not.toContain('message-2')
    expect
      .soft(recordLiteraturePdfRead.mock.calls.map(([request]) => request.promptMessageId))
      .not.toContain('message-2')
    recordLiteratureSearch.mockClear()
    recordLiteraturePdfRead.mockClear()
    await handler.searchLibrary({ query: 'current question' })
    await handler.readPdf({ itemId: 'current-item', query: 'current findings' })
    expect(recordLiteratureSearch).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessageId: 'message-2', query: 'current question' })
    )
    expect(recordLiteraturePdfRead).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessageId: 'message-2', itemId: 'current-item' })
    )
  })

  it('does not register an empty production PDF search as delivered PDF evidence', async () => {
    const checksum = 'a'.repeat(64)
    const { root, handler, recordLiteraturePdfRead } = await setup({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readPdf: async ({ query }) => ({
        itemTitle: 'Paper',
        evidence: (await reader.searchAttachment({
          projectId: 'project-1',
          attachmentId: 'attachment-1',
          attachmentVersionId: 'version-1',
          filename: 'paper.pdf',
          sizeBytes: 42,
          checksum,
          query
        })) as Record<string, unknown>
      })
    })
    vi.mocked(extractPdfText).mockResolvedValue({
      text: '--- Page 1 ---\nA retrieval evaluator identifies incorrect documents.\n--- Page 2 ---\nThe method improves reliability.',
      pageCount: 2,
      truncated: false
    })
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn() },
      sources: {
        resolveVersion: vi.fn(async () => ({
          sourceKind: 'literature-attachment-version' as const,
          sourceFileId: 'attachment-1',
          sourceVersionId: 'version-1',
          filename: 'paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: 42,
          checksum,
          path: join(root, 'paper.pdf')
        }))
      }
    })
    const empty = await handler.readPdf({ itemId: 'item-1', query: 'photosynthesis' })
    expect(empty?.evidence).toMatchObject({ scope: 'relevant-passages', passages: [] })
    expect.soft(recordLiteraturePdfRead).not.toHaveBeenCalled()
    recordLiteraturePdfRead.mockClear()
    const matching = await handler.readPdf({ itemId: 'item-1', query: 'retrieval evaluator' })
    expect(matching?.evidence.passages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('retrieval evaluator') })
      ])
    )
    expect(recordLiteraturePdfRead).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'item-1', promptMessageId: 'message-1' })
    )
  })
})

it.each([
  ['claude-code', claudeCodeFramework, false],
  ['opencode', opencodeFramework, false],
  ['codex-response', codexFramework, false],
  ['codex-bridge', codexFramework, true]
] as const)(
  'records only nonempty abstracts in the owning %s capability path',
  async (_path, framework, bridge) => {
    const readAbstract = vi.fn(async () => ({
      itemId: 'item-1',
      metadataRevision: 1,
      title: 'Paper',
      abstract: 'Useful findings.'
    }))
    const { handler, owners, interaction, recordLiteratureAbstractRead } = await setup(
      { searchLibrary: vi.fn(), readPdf: vi.fn(), readAbstract },
      framework,
      bridge
    )
    await handler.readAbstract({ itemId: 'item-1' })
    expect(recordLiteratureAbstractRead).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessageId: 'message-1', itemId: 'item-1' })
    )
    recordLiteratureAbstractRead.mockClear()
    readAbstract.mockResolvedValueOnce({
      itemId: 'item-1',
      metadataRevision: 1,
      title: 'Paper',
      abstract: '  '
    })
    await handler.readAbstract({ itemId: 'item-1' })
    expect(recordLiteratureAbstractRead).not.toHaveBeenCalled()
    let complete!: (result: Awaited<ReturnType<typeof readAbstract>>) => void
    readAbstract.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const pending = handler.readAbstract({ itemId: 'item-1' })
    owners.sessionInteractions.supersede(interaction)
    owners.sessionInteractions.claim({
      sessionId: 'session-1',
      kind: 'prompt',
      promptMessageId: 'message-2'
    })
    complete({ itemId: 'item-1', metadataRevision: 1, title: 'Paper', abstract: 'Old findings.' })
    await pending
    expect(recordLiteratureAbstractRead).not.toHaveBeenCalled()
  }
)
