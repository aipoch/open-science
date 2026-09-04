import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ContextUsageTracker } from './context-usage-tracker'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'

const projectRoot = resolve(__dirname, '../../..')

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
