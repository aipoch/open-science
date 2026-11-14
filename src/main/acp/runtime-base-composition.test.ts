import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContextUsageTracker } from './context-usage-tracker'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { claudeCodeFramework, opencodeFramework, codexFramework } from '../agent-framework'
import type {
  LiteratureLibraryMcpHandler,
  LiteratureLibraryFullTextSearchResult
} from '../literature/library-mcp-server'
import type { AgentMcpHttpHost } from './mcp-http-host'
import { CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY } from './session-capability-owner'

const projectRoot = resolve(__dirname, '../../..')
const temporaryRoots: string[] = []

// Preserve the inferred Vitest mock signatures used by the deferred-result checks below.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const createScopedLibraryHarness = async (
  searchLibraryFullText?: LiteratureLibraryMcpHandler['searchLibraryFullText']
) => {
  let handler!: LiteratureLibraryMcpHandler
  const host = {
    ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
    registerLiteratureLibrary: vi.fn((_id: string, next: LiteratureLibraryMcpHandler) => {
      handler = next
    }),
    urlFor: vi.fn((kind: string, id: string) => `http://127.0.0.1:5/${kind}/${id}`),
    unregister: vi.fn(),
    clear: vi.fn(),
    close: vi.fn()
  } as unknown as AgentMcpHttpHost
  const library = {
    ...(searchLibraryFullText ? { searchLibraryFullText } : {}),
    searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
    readAbstract: vi.fn(async () => ({
      itemId: 'inside',
      metadataRevision: 1,
      title: 'Inside',
      abstract: 'Evidence.'
    })),
    readPdf: vi.fn(async () => ({
      itemTitle: 'Inside',
      evidence: { passages: [{ content: 'Evidence.' }] }
    })),
    formatReferences: vi.fn(async () => ({ references: [] })),
    saveToInbox: vi.fn(async () => ({ results: [] }))
  }
  const owners = composeAcpRuntimeBaseOwners({
    appVersion: 'test',
    defaultCwd: '/workspace',
    mcpHttpHost: host,
    literatureLibrary: library
  })
  const provision = await owners.sessionCapabilities.provision({
    stableAppSessionId: 'session-1',
    framework: claudeCodeFramework,
    nativeMcpEnabled: true,
    bridgeMcpAliasesEnabled: false,
    policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
    sessionCwd: '/workspace',
    projectId: 'project-1'
  })
  return { owners, handler, library, provision }
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('ACP Runtime base composition', () => {
  const emptyCachedResult: LiteratureLibraryFullTextSearchResult = {
    scope: 'project',
    query: 'evidence',
    status: 'available',
    retrievalMode: 'bm25',
    coverageKind: 'cached-text-only',
    fullTextCoverage: 'unverified',
    coverage: {
      requestedDocuments: 0,
      cachedDocuments: 0,
      notCachedDocuments: 0,
      unavailableDocuments: 0
    },
    recordCount: 0,
    totalRecordCount: 0,
    sourceSelectionTruncated: false,
    resultsRevalidated: true,
    incomplete: true,
    limitations: ['cached-pages-unverified'],
    scannedSources: 0,
    matches: [],
    truncated: false
  }

  it.each([false, true])(
    'forwards the sole full-text cancellation source without recombining it; prompt: %s',
    async (withPrompt) => {
      const search = vi.fn<NonNullable<LiteratureLibraryMcpHandler['searchLibraryFullText']>>(
        async () => emptyCachedResult
      )
      const { owners, handler, provision } = await createScopedLibraryHarness(search)
      const interaction = withPrompt
        ? owners.sessionInteractions.claim({
            sessionId: 'session-1',
            kind: 'prompt',
            parts: [{ type: 'literature-scope', scope: 'project' }]
          })
        : undefined
      const controller = new AbortController()
      try {
        await expect(
          handler.searchLibraryFullText!({
            query: 'evidence',
            ...(withPrompt ? {} : { signal: controller.signal })
          })
        ).resolves.toEqual(emptyCachedResult)
        expect(search.mock.calls[0][0].signal).toBe(interaction?.signal ?? controller.signal)
      } finally {
        if (interaction) owners.sessionInteractions.release(interaction)
        provision.release({ ownsStableIdentity: true })
      }
    }
  )

  it.each(['request', 'interaction'] as const)(
    'cancels full-text discovery through the %s signal and rejects a late result',
    async (source) => {
      let finish!: (result: LiteratureLibraryFullTextSearchResult) => void
      const search = vi.fn<NonNullable<LiteratureLibraryMcpHandler['searchLibraryFullText']>>(
        () => new Promise((resolveResult) => (finish = resolveResult))
      )
      const { owners, handler, provision } = await createScopedLibraryHarness(search)
      const interaction = owners.sessionInteractions.claim({
        sessionId: 'session-1',
        kind: 'prompt',
        parts: [{ type: 'literature-scope', scope: 'project' }]
      })
      const controller = new AbortController()
      try {
        const pending = handler.searchLibraryFullText!({
          query: 'evidence',
          signal: controller.signal
        })
        const rejected = expect(pending).rejects.toThrow()
        const forwarded = search.mock.calls[0][0].signal!
        expect(forwarded.aborted).toBe(false)
        if (source === 'request') controller.abort()
        else owners.sessionInteractions.supersede(interaction)
        expect(forwarded.aborted).toBe(true)
        finish(emptyCachedResult)
        await rejected
      } finally {
        owners.sessionInteractions.release(interaction)
        provision.release({ ownsStableIdentity: true })
      }
    }
  )

  it('binds every evidence operation to all selected scopes while retaining ordinary Library tools', async () => {
    const { owners, handler, library, provision } = await createScopedLibraryHarness()
    const interaction = owners.sessionInteractions.claim({
      sessionId: 'session-1',
      kind: 'prompt',
      parts: [
        { type: 'literature-scope', scope: 'collection', collectionId: 'first', name: 'First' },
        { type: 'literature-scope', scope: 'collection', collectionId: 'second', name: 'Second' },
        { type: 'literature', itemId: 'picked', metadataRevision: 1, item: {} as never },
        { type: 'literature', itemId: 'also-picked', metadataRevision: 1, item: {} as never }
      ]
    })
    for (const scope of ['library', 'project', undefined, 'items'] as const) {
      await expect(handler.searchLibrary({ scope, itemIds: ['outside'] })).rejects.toThrow(
        'LIBRARY_SCOPE_MISMATCH'
      )
      await expect(handler.readAbstract({ itemId: 'outside', scope })).rejects.toThrow(
        'LIBRARY_SCOPE_MISMATCH'
      )
      await expect(
        handler.readPdf({ itemId: 'outside', query: 'evidence', scope })
      ).rejects.toThrow('LIBRARY_SCOPE_MISMATCH')
    }
    await expect(
      handler.searchLibrary({ scope: 'collection', collectionId: 'unselected' })
    ).rejects.toThrow('LIBRARY_SCOPE_MISMATCH')
    await expect(
      handler.searchLibrary({ scope: 'items', itemIds: ['picked', 'outside'] })
    ).rejects.toThrow('LIBRARY_SCOPE_MISMATCH')
    expect(library.searchLibrary).not.toHaveBeenCalled()
    expect(library.readAbstract).not.toHaveBeenCalled()
    expect(library.readPdf).not.toHaveBeenCalled()
    for (const collectionId of ['first', 'second']) {
      await handler.searchLibrary({ scope: 'collection', collectionId })
      await handler.readAbstract({ itemId: 'inside', scope: 'collection', collectionId })
      await handler.readPdf({
        itemId: 'inside',
        query: 'evidence',
        scope: 'collection',
        collectionId
      })
    }
    await handler.searchLibrary({ scope: 'items', itemIds: ['also-picked', 'picked'] })
    await handler.readAbstract({ itemId: 'also-picked', scope: 'items' })
    await handler.readPdf({ itemId: 'picked', query: 'evidence', scope: 'items' })
    // Bibliography formatting is not an evidence read and keeps its existing contract.
    await handler.formatReferences!({ itemIds: ['outside'], styleId: 'apa', locale: 'en-US' })
    expect(library.formatReferences).toHaveBeenCalledOnce()
    owners.sessionInteractions.release(interaction)
    const project = owners.sessionInteractions.claim({
      sessionId: 'session-1',
      kind: 'prompt',
      parts: [{ type: 'literature-scope', scope: 'project' }]
    })
    await handler.searchLibrary({})
    await handler.readAbstract({ itemId: 'inside' })
    await expect(handler.readAbstract({ itemId: 'outside', scope: 'library' })).rejects.toThrow(
      'LIBRARY_SCOPE_MISMATCH'
    )
    owners.sessionInteractions.release(project)
    owners.sessionInteractions.claim({ sessionId: 'session-1', kind: 'prompt' })
    await handler.searchLibrary({ scope: 'library' })
    await handler.readAbstract({ itemId: 'outside', scope: 'items' })
    await handler.readPdf({ itemId: 'outside', query: 'evidence', scope: 'library' })
    provision.release({ ownsStableIdentity: true })
  })

  it.each(['searchLibrary', 'readAbstract', 'readPdf'] as const)(
    'discards late %s results and clears the old scope when a prompt is replaced',
    async (operation) => {
      const { owners, handler, library, provision } = await createScopedLibraryHarness()
      const interaction = owners.sessionInteractions.claim({
        sessionId: 'session-1',
        kind: 'prompt',
        parts: [{ type: 'literature-scope', scope: 'collection', collectionId: 'old', name: 'Old' }]
      })
      let resolve!: (value: never) => void
      library[operation].mockImplementationOnce(
        () =>
          new Promise<never>((done) => {
            resolve = done
          })
      )
      const request = {
        itemId: 'inside',
        query: 'evidence',
        scope: 'collection' as const,
        collectionId: 'old'
      }
      const pending = handler[operation]!(request)
      const rejected = expect(pending).rejects.toThrow()
      owners.sessionInteractions.supersede(interaction)
      const next = owners.sessionInteractions.claim({
        sessionId: 'session-1',
        kind: 'prompt',
        parts: [{ type: 'literature-scope', scope: 'collection', collectionId: 'new', name: 'New' }]
      })
      resolve({} as never)
      await rejected
      await expect(handler[operation]!({ ...request, collectionId: 'old' })).rejects.toThrow(
        'LIBRARY_SCOPE_MISMATCH'
      )
      await handler[operation]!({ ...request, collectionId: 'new' })
      owners.sessionInteractions.release(interaction)
      expect(owners.sessionInteractions.current('session-1')).toBe(next)
      owners.sessionInteractions.release(next)
      library[operation].mockImplementationOnce(
        () =>
          new Promise<never>((done) => {
            resolve = done
          })
      )
      const idleResult = handler[operation]!({ ...request, scope: 'library' })
      const discardIdleResult = expect(idleResult).rejects.toThrow('LIBRARY_CONTEXT_CHANGED')
      const newest = owners.sessionInteractions.claim({
        sessionId: 'session-1',
        kind: 'prompt',
        parts: [{ type: 'literature-scope', scope: 'project' }]
      })
      resolve({} as never)
      await discardIdleResult
      owners.sessionInteractions.release(newest)
      provision.release({ ownsStableIdentity: true })
    }
  )

  it('builds a fresh closed owner graph and preserves injected shared dependencies', () => {
    const contextUsageTracker = new ContextUsageTracker()
    const setTimer = vi.fn(() => 1 as never)
    const clearTimer = vi.fn()
    const options = {
      appVersion: 'test',
      defaultCwd: '/workspace/..//workspace',
      contextUsageTracker,
      setTimer,
      clearTimer
    }

    const first = composeAcpRuntimeBaseOwners(options)
    const second = composeAcpRuntimeBaseOwners(options)

    expect(Object.isFrozen(first)).toBe(true)
    expect(first.snapshotOwner.cwd).toBe(resolve(options.defaultCwd))
    expect(first.contextUsageTracker).toBe(contextUsageTracker)
    expect(first.setTimer).toBe(setTimer)
    expect(first.clearTimer).toBe(clearTimer)
    expect(first.artifactTurns).toBeUndefined()
    expect(first.planService).toBeUndefined()
    expect(first.snapshotOwner).not.toBe(second.snapshotOwner)
    expect(first.connectionResources).not.toBe(second.connectionResources)
    expect(first.generationActivity).not.toBe(second.generationActivity)
    expect(first.connectionTransitions).not.toBe(second.connectionTransitions)
  })

  it('forwards the managed Version reader to prompt attachment resolution', async () => {
    const attachment = {
      id: 'upload-file-1',
      versionId: 'upload-version-1',
      versionNumber: 1,
      sessionId: 'session-1',
      name: 'notes.txt',
      originalName: 'notes.txt',
      path: 'upload-version:stale',
      mimeType: 'text/plain',
      size: 0,
      checksum: '1'.repeat(64),
      createdAt: '2026-08-23T00:00:00.000Z'
    }
    const close = vi.fn(async () => undefined)
    const openLatest = vi.fn(async () => ({
      path: '/managed/v2_notes.txt',
      size: 0,
      read: vi.fn(),
      readRange: vi.fn(),
      copyTo: vi.fn(async (destinationPath: string) =>
        writeFile(destinationPath, Buffer.alloc(0), { flag: 'wx' })
      ),
      verifyUnchanged: vi.fn(async () => undefined),
      close,
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
        sizeBytes: 0n,
        checksum: '2'.repeat(64),
        createdAt: new Date('2026-08-24T00:00:00.000Z')
      },
      versionToken: 2,
      snapshot: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n }
    }))
    const owners = composeAcpRuntimeBaseOwners({
      appVersion: 'test',
      defaultCwd: '/workspace',
      artifacts: {
        configRoot: '/config',
        dataRoot: '/data',
        projectId: 'project-1',
        mcpEntryPath: '/mcp',
        managedFileVersions: { openLatest, openVersion: vi.fn(), openUnpublishedVersion: vi.fn() }
      },
      uploads: {
        repository: {
          finalizePendingSessionUploads: vi.fn(async () => [attachment])
        } as never
      }
    })

    const prepared = await owners.promptContentOwner.prepare({
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

    expect(openLatest).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'project-1',
      fileId: 'upload-file-1'
    })
    expect(prepared.turnInputs?.uploads[0]?.versionId).toBe('upload-version-2')
    expect(close).toHaveBeenCalledOnce()
    prepared.close()
  })

  it('binds the generation and connection effects once before the graph is used', async () => {
    const owners = composeAcpRuntimeBaseOwners({
      appVersion: 'test',
      defaultCwd: '/workspace'
    })
    const hasActiveSessions = vi.fn(() => false)
    const activityChanged = vi.fn()
    const disconnect = vi.fn(async () => ({}) as never)
    const recoverFailedDeferredDisconnect = vi.fn()
    const publishIdle = vi.fn()

    expect(() => owners.generationActivity.blockers()).toThrow(
      'ACP generation/connection effects are not bound.'
    )

    owners.bindGenerationConnectionEffects({
      reviewerSessions: { hasActiveSessions },
      modelChanges: { activityChanged },
      connectionClose: { disconnect, recoverFailedDeferredDisconnect },
      publishIdle
    })

    expect(owners.generationActivity.blockers()).toEqual({
      reconnect: false,
      retirement: false
    })
    await owners.generationActivity.withActivity(async () => {
      const { resourceActivity } = await import('../resource-diagnostics/activity')
      expect(resourceActivity.state.sampling).toBe(true)
    })
    const { resourceActivity } = await import('../resource-diagnostics/activity')
    expect(resourceActivity.state.sampling).toBe(false)
    expect(activityChanged).toHaveBeenCalledTimes(2)

    await owners.connectionTransitions.requestProviderReconnect()
    expect(disconnect).toHaveBeenCalledWith(false)
    expect(publishIdle).toHaveBeenCalledOnce()
    expect(() =>
      owners.bindGenerationConnectionEffects({
        reviewerSessions: { hasActiveSessions },
        modelChanges: { activityChanged },
        connectionClose: { disconnect, recoverFailedDeferredDisconnect },
        publishIdle
      })
    ).toThrow('ACP generation/connection effects are already bound.')
  })

  it.each([
    ['claude-code', claudeCodeFramework, true, false],
    ['opencode', opencodeFramework, true, false],
    ['codex-response', codexFramework, true, false],
    ['codex-response compatibility', codexFramework, false, true],
    ['codex-bridge', codexFramework, false, true]
  ] as const)(
    'forwards literature cancellation signals with trusted origin for %s',
    async (_path, framework, nativeMcpEnabled, bridgeMcpAliasesEnabled) => {
      let handler: LiteratureLibraryMcpHandler | undefined
      const host = {
        ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
        registerLiteratureLibrary: vi.fn((_id: string, next: LiteratureLibraryMcpHandler) => {
          handler = next
        }),
        urlFor: vi.fn((kind: string, id: string) => `http://127.0.0.1:5/${kind}/${id}`),
        unregister: vi.fn(),
        clear: vi.fn(),
        close: vi.fn()
      } as unknown as AgentMcpHttpHost
      const acquirePdf = vi.fn<
        (request: { signal?: AbortSignal }) => Promise<{ status: 'not-found' }>
      >(async () => ({ status: 'not-found' }))
      const saveToInbox = vi.fn(async () => ({ results: [], cancelled: true }))
      const resolveSaveReferences = vi.fn(async () => [])
      const readCandidateFile = vi.fn(async () => '{}')
      const owners = composeAcpRuntimeBaseOwners({
        appVersion: 'test',
        defaultCwd: '/workspace',
        mcpHttpHost: host,
        literatureLibrary: {
          acquirePdf,
          searchLibrary: vi.fn(),
          readAbstract: vi.fn(),
          readPdf: vi.fn(),
          saveToInbox,
          resolveSaveReferences,
          readCandidateFile
        }
      })
      const provision = await owners.sessionCapabilities.provision({
        stableAppSessionId: 'session-1',
        framework,
        nativeMcpEnabled,
        bridgeMcpAliasesEnabled,
        policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
        sessionCwd: '/workspace',
        projectId: 'project-1'
      })
      const candidate = {
        item: { title: 'A paper' },
        source: { provider: 'crossref', rawMetadata: {} }
      } as Parameters<NonNullable<LiteratureLibraryMcpHandler['acquirePdf']>>[0]['candidate']
      const controller = new AbortController()
      await handler!.acquirePdf!({ candidate, signal: controller.signal })
      expect(acquirePdf).toHaveBeenCalledWith({
        candidate,
        signal: controller.signal,
        projectId: 'project-1',
        sessionId: 'session-1'
      })
      const saved = await handler!.saveToInbox({
        candidates: [candidate],
        signal: controller.signal
      })
      expect(saved).toEqual({ results: [], cancelled: true })
      expect(saveToInbox).toHaveBeenCalledWith({
        candidates: [candidate],
        signal: controller.signal,
        projectId: 'project-1',
        sessionId: 'session-1'
      })
      await handler!.resolveSaveReferences!(['doi:10.1234/paper'], controller.signal)
      expect(resolveSaveReferences).toHaveBeenCalledWith(['doi:10.1234/paper'], controller.signal)
      await handler!.readCandidateFile!('candidates.json', controller.signal)
      expect(readCandidateFile).toHaveBeenCalledWith({
        filename: 'candidates.json',
        signal: controller.signal,
        projectId: 'project-1',
        sessionId: 'session-1',
        workspaceCwd: '/workspace'
      })
      controller.abort()
      expect(acquirePdf.mock.calls[0][0].signal!.aborted).toBe(true)
      provision.release({ ownsStableIdentity: true })
    }
  )

  it('stamps the trusted Project and Session origin onto Agent literature discoveries', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'open-science-literature-artifact-'))
    temporaryRoots.push(dataRoot)
    let handler: LiteratureLibraryMcpHandler | undefined
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
      registerArtifact: vi.fn(),
      registerLiteratureLibrary: vi.fn(
        (_routingId: string, nextHandler: LiteratureLibraryMcpHandler) => {
          handler = nextHandler
        }
      ),
      urlFor: vi.fn((kind: string, routingId: string) => `http://127.0.0.1:5/${kind}/${routingId}`),
      unregister: vi.fn(),
      clear: vi.fn(),
      close: vi.fn()
    } as unknown as AgentMcpHttpHost
    const searchLibrary = vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false }))
    const readAbstract = vi.fn(async () => undefined)
    const readPdf = vi.fn(async () => ({
      itemTitle: 'Paper',
      evidence: { passages: [{ content: 'Findings.' }] }
    }))
    const resolveSaveReferences = vi.fn(async () => [])
    const formatReferences = vi.fn(async () => ({
      references: [
        {
          itemId: 'item-1',
          inText: '(Author, 2025)',
          reference: 'Author, A. (2025). A cited paper.'
        }
      ]
    }))
    const formatCitationDocument = vi.fn(async () => ({
      filename: 'review.cited.docx',
      citationCount: 1,
      referenceCount: 1,
      contentBase64: Buffer.from('formatted docx').toString('base64'),
      literature: {
        styleId: 'apa',
        locale: 'en-US',
        citations: [{ citationId: 'citation-1', itemId: 'item-1' }]
      }
    }))
    const prepareLatexBundle = vi.fn(async () => ({
      filename: 'review.latex.zip',
      citationCount: 1,
      referenceCount: 1,
      contentBase64: Buffer.from('latex zip').toString('base64'),
      literature: {
        styleId: 'apa',
        locale: 'en-US',
        citations: [{ citationId: 'citation-1', itemId: 'item-1' }]
      }
    }))
    const saveToInbox = vi.fn(async () => ({ results: [] }))
    const recordLiteratureSearch = vi.fn()
    const recordLiteraturePdfRead = vi.fn()
    const writeAppGeneratedVersion = vi.fn(async (request) => ({
      id: `version-${request.filename}`,
      name: request.filename,
      path: `/managed/${request.filename}`,
      fileUrl: `file:///managed/${request.filename}`,
      mimeType: request.contentType,
      size: 1,
      mtimeMs: 1,
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      versionId: `version-${request.filename}`
    }))
    const owners = composeAcpRuntimeBaseOwners({
      appVersion: 'test',
      defaultCwd: '/workspace',
      mcpHttpHost: host,
      artifacts: {
        configRoot: '/config',
        dataRoot,
        projectId: 'project-1',
        mcpEntryPath: '/mcp',
        provenance: {
          listRunVersions: vi.fn(async () => []),
          writeAppGeneratedVersion,
          recordLiteratureSearch,
          recordLiteraturePdfRead
        } as never
      },
      literatureLibrary: {
        searchLibrary,
        readAbstract,
        readPdf,
        resolveSaveReferences,
        formatReferences,
        formatCitationDocument,
        prepareLatexBundle,
        saveToInbox
      }
    })
    const provision = await owners.sessionCapabilities.provision({
      stableAppSessionId: 'session-1',
      framework: claudeCodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1'
    })

    expect(handler).toBeDefined()
    const interaction = owners.sessionInteractions.claim({
      sessionId: 'session-1',
      kind: 'prompt',
      promptMessageId: 'message-1'
    })
    const artifactTurn = await owners.artifactTurns!.openRootExecution({
      executionId: interaction.turnToken,
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      projectId: 'project-1',
      agentName: 'Test Agent',
      provenanceContext: {
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'message-1'
      }
    })
    await handler!.searchLibrary({ query: 'retrieval', scope: 'project', offset: 20 })
    await handler!.readAbstract({ itemId: 'item-1', scope: 'project' })
    await handler!.readPdf({ itemId: 'item-1', query: 'outcome', scope: 'project' })
    await handler!.resolveSaveReferences?.(['pmid:35486828'])
    await handler!.formatReferences?.({
      itemIds: ['item-1'],
      styleId: 'apa',
      locale: 'en-US'
    })
    await handler!.formatCitationDocument?.({
      filename: 'review.docx',
      styleId: 'apa',
      locale: 'en-US'
    })
    await handler!.prepareLatexBundle?.({ filename: 'review.tex' })
    await handler!.saveToInbox({ candidates: [] })

    expect(searchLibrary).toHaveBeenCalledWith({
      query: 'retrieval',
      scope: 'project',
      offset: 20,
      projectId: 'project-1'
    })
    expect(recordLiteratureSearch).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      promptMessageId: 'message-1',
      query: 'retrieval',
      scope: 'project',
      offset: 20,
      result: { items: [], totalCount: 0, hasMore: false }
    })
    expect(formatCitationDocument).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      filename: 'review.docx',
      styleId: 'apa',
      locale: 'en-US'
    })
    expect(prepareLatexBundle).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      filename: 'review.tex'
    })
    expect(readAbstract).toHaveBeenCalledWith({
      itemId: 'item-1',
      scope: 'project',
      projectId: 'project-1'
    })
    expect(readPdf).toHaveBeenCalledWith({
      itemId: 'item-1',
      query: 'outcome',
      scope: 'project',
      projectId: 'project-1'
    })
    expect(recordLiteraturePdfRead).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      promptMessageId: 'message-1',
      itemId: 'item-1'
    })
    expect(resolveSaveReferences).toHaveBeenCalledWith(['pmid:35486828'], undefined)
    expect(formatReferences).toHaveBeenCalledWith({
      projectId: 'project-1',
      itemIds: ['item-1'],
      styleId: 'apa',
      locale: 'en-US'
    })
    expect(saveToInbox).toHaveBeenCalledWith({
      candidates: [],
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(writeAppGeneratedVersion).toHaveBeenCalledTimes(2)
    expect(writeAppGeneratedVersion).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        filename: 'review.cited.docx',
        content: Buffer.from('formatted docx').toString('base64'),
        encoding: 'base64',
        literature: expect.objectContaining({ styleId: 'apa' }),
        producer: expect.objectContaining({
          connectorId: 'open-science-library',
          toolId: 'format_citation_document'
        })
      })
    )
    expect(writeAppGeneratedVersion).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filename: 'review.latex.zip',
        encoding: 'base64',
        producer: expect.objectContaining({ toolId: 'prepare_latex_bundle' })
      })
    )
    await owners.artifactTurns!.dispose(artifactTurn)
    let resolveLatePdf!: (value: Awaited<ReturnType<typeof readPdf>>) => void
    readPdf.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveLatePdf = done
        })
    )
    const latePdf = handler!.readPdf({ itemId: 'item-1', query: 'late', scope: 'project' })
    const discarded = expect(latePdf).rejects.toThrow('LIBRARY_CONTEXT_CHANGED')
    owners.sessionInteractions.release(interaction)
    const replacement = owners.sessionInteractions.claim({
      sessionId: 'session-1',
      kind: 'prompt',
      promptMessageId: 'message-2'
    })
    resolveLatePdf({
      itemTitle: 'Late Paper',
      evidence: { passages: [{ content: 'Late evidence.' }] }
    })
    await discarded
    expect(recordLiteraturePdfRead).toHaveBeenCalledOnce()
    owners.sessionInteractions.release(interaction)
    expect(owners.sessionInteractions.current('session-1')).toBe(replacement)
    owners.sessionInteractions.release(replacement)
    provision.release({ ownsStableIdentity: true })
  })

  it('keeps the canonical composer outside Runtime and Electron dependencies outside the composer', () => {
    const runtime = readFileSync(resolve(projectRoot, 'src/main/acp/runtime.ts'), 'utf8')
    const composer = readFileSync(
      resolve(projectRoot, 'src/main/acp/runtime-base-composition.ts'),
      'utf8'
    )
    const applicationComposition = readFileSync(
      resolve(projectRoot, 'src/main/acp/runtime-composition.ts'),
      'utf8'
    )

    expect(runtime).not.toMatch(
      /new (?:AcpRuntimeSnapshotOwner|AcpConnectionResourceOwner|AcpBackendGenerationOwner|ContextUsageTracker|AcpSessionInteractionOwner|AcpSessionCapabilityOwner|AcpGenerationActivityOwner|AcpConnectionTransitionOwner|AcpTurnSkillOwner|AcpSessionConfigurator|ArtifactTurnOwner|SessionPlanInteractionOwner|AcpPromptContentOwner|AcpSessionPresentationPolicy|AcpPromptOutcomeFinalizer)/
    )
    expect(composer).not.toMatch(/from ['"]electron['"]|import \{ AcpRuntime \}/)
    expect(composer).toMatch(/import type \{ AcpRuntimeOptions \} from '\.\/runtime(?:-contract)?'/)
    expect(applicationComposition).toContain('composeAcpRuntimeBaseOwners(runtimeOptions)')
    expect(applicationComposition).toContain(
      'composeAcpRuntimeSessionOwners(runtimeOptions, baseOwners)'
    )
    expect(runtime + applicationComposition).not.toContain('runtime.test-utils')
  })
})
