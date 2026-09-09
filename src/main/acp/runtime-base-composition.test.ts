import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContextUsageTracker } from './context-usage-tracker'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { claudeCodeFramework, opencodeFramework, codexFramework } from '../agent-framework'
import type { LiteratureLibraryMcpHandler } from '../literature/library-mcp-server'
import type { AgentMcpHttpHost } from './mcp-http-host'
import { CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY } from './session-capability-owner'

const projectRoot = resolve(__dirname, '../../..')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('ACP Runtime base composition', () => {
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
    await owners.generationActivity.withActivity(async () => undefined)
    expect(activityChanged).toHaveBeenCalledOnce()

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
    owners.sessionInteractions.release(interaction)
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
    expect(composer).toContain("import type { AcpRuntimeOptions } from './runtime'")
    expect(applicationComposition).toContain('composeAcpRuntimeBaseOwners(runtimeOptions)')
    expect(applicationComposition).toContain(
      'composeAcpRuntimeSessionOwners(runtimeOptions, baseOwners)'
    )
    expect(runtime + applicationComposition).not.toContain('runtime.test-utils')
  })
})
