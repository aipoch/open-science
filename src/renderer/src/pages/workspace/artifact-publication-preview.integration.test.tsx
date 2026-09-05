// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() }
}))

// Keep unrelated transcript layout and syntax highlighting out of the preview lifecycle.
vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: PropsWithChildren) => <div>{children}</div>
}))
vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
  PresentedAgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

import { createArtifactHandlers } from '../../../../main/artifacts/ipc'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from '../../../../main/artifacts/provenance-test-fixtures'
import { ArtifactProvenanceRepository } from '../../../../main/artifacts/provenance-repository'
import { SessionRepository } from '../../../../main/session-persistence/repository'
import { createLinearConversationGraph } from '../../../../shared/conversation-graph'
import type { ArtifactFile } from '../../../../shared/artifacts'
import { createCachedImageFetchResponse } from './previews/cached-preview-image.test-support'
import { ArtifactRunRegistry } from '../../../../main/artifacts/run-registry'
import { ManagedFileVersionService } from '../../../../main/managed-file-versions/service'
import { ManagedPreviewResources } from '../../../../main/managed-preview-resources'
import { WorkspaceMessageItem } from './WorkspaceMessageItem'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('native Artifact publication and transcript preview', () => {
  let fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    fixture = await createProvenanceTestFixture()
    await fixture.client.project.create({ data: { id: 'project-1', name: 'Preview test' } })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    container.remove()
    delete (window as unknown as { api?: unknown }).api
    await fixture.dispose()
  })

  it.each(['native', 'compatibility', 'delayed publication'] as const)(
    'keeps preview synchronized with publication: %s',
    async (layout) => {
      const messages = [
        {
          id: 'prompt-1',
          role: 'user' as const,
          content: 'Generate a plot',
          status: 'complete' as const,
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'message-1',
          role: 'agent' as const,
          content: 'Generated the plot.',
          status: 'complete' as const,
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
      const graph = createLinearConversationGraph({
        sessionId: 'session-1',
        messages,
        frameworkId: 'claude-code',
        createdAt: 1,
        updatedAt: 2
      })
      const context = {
        rootFrameId: graph.rootFrameId,
        agentFrameId: graph.activeFrameId,
        messageBranchId: graph.branches[0].id,
        runtimeSegmentId: graph.runtimeSegments[0].id,
        promptMessageId: 'prompt-1'
      }
      const sessions = new SessionRepository(fixture.storageRoot)
      await sessions.saveSession({
        id: 'session-1',
        projectId: 'project-1',
        title: 'Plot',
        cwd: fixture.storageRoot,
        status: 'idle',
        messages,
        conversationGraph: graph,
        createdAt: 1,
        updatedAt: 2
      })
      fixture.repository = new ArtifactProvenanceRepository({
        ...fixture.repositoryOptions,
        loadSession: (projectId, sessionId) => sessions.loadSession(projectId, sessionId)
      })
      await fixture.compatibilityRepository.writePendingFile({
        projectId: 'project-1',
        sessionId: 'artifact-session-1',
        runId: 'artifact-run-1',
        filename: 'plot.png',
        source: {
          kind: 'inline',
          encoding: 'base64',
          content:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
        }
      })
      const version = await fixture.repository.createVersion(createArtifactVersionRequest(context))
      // Use the actual descriptor emitted for this run, including its immutable content path.
      const [artifact] = await fixture.repository.listRunVersions({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1'
      })
      expect(artifact.versionId).toBe(version.versionId)
      await expect(
        fixture.client.artifactLineage.findUniqueOrThrow({ where: { id: artifact.artifactId } })
      ).resolves.toMatchObject({ currentVersionId: null })

      const versions = new ManagedFileVersionService({
        storageRoot: fixture.storageRoot,
        getClient: () => Promise.resolve(fixture.client)
      })
      const resources = new ManagedPreviewResources({
        resolvePath: async () => {
          throw new Error('Native previews must use the managed Version boundary.')
        },
        openLatestManagedFile: (source, request) => versions.openLatest({ ...request, source }),
        openManagedFileVersion: (source, request) =>
          versions.openVersion({ ...request, source }, request.versionId)
      })
      const registry = new ArtifactRunRegistry()
      const handlers = createArtifactHandlers(fixture.compatibilityRepository, registry, {
        provenance: fixture.repository,
        openLatestManagedFile: (request) =>
          versions.openLatest({
            source: 'artifact',
            projectId: request.projectId!,
            fileId: request.fileId!
          }),
        openManagedFileVersion: (request) =>
          versions.openVersion(
            { source: 'artifact', projectId: request.projectId!, fileId: request.fileId! },
            request.versionId
          )
      })
      const attempts: Promise<unknown>[] = []
      const errors: { channel: string; code: unknown; message: string }[] = []
      const observe = <T,>(channel: string, attempt: Promise<T>): Promise<T> => {
        attempts.push(attempt)
        return attempt.catch((error: Error & { code?: unknown }) => {
          errors.push({ channel, code: error.code, message: error.message })
          throw error
        })
      }
      window.api = {
        artifacts: {
          readPreview: vi.fn((request) =>
            observe('artifacts:read-preview', handlers.readPreview(request))
          )
        },
        previewResources: {
          acquire: vi.fn((request) =>
            observe('preview-resources:acquire', resources.acquire(1, request))
          ),
          release: vi.fn(async (request) => resources.release(1, request))
        }
      } as unknown as Window['api']
      vi.useFakeTimers()
      vi.stubGlobal('IntersectionObserver', undefined)

      const renderArtifact = async (displayArtifact: ArtifactFile): Promise<void> => {
        await act(async () => {
          root.render(
            <WorkspaceMessageItem
              message={{
                id: 'message-1',
                role: 'agent',
                status: 'complete',
                content: 'Generated the plot.',
                eventIds: [],
                artifactIds: [artifact.id],
                createdAt: 1,
                updatedAt: 2
              }}
              artifacts={[
                {
                  ...displayArtifact,
                  createdAt: displayArtifact.createdAt
                    ? Date.parse(displayArtifact.createdAt)
                    : undefined,
                  ...(layout === 'compatibility'
                    ? { path: '/managed/session/.pending/artifact-run-1/plot.png' }
                    : {}),
                  kind: 'managed-file',
                  resolvedProjectId: 'project-1',
                  resolvedSessionId: 'session-1'
                }
              ]}
              onPreviewArtifact={vi.fn()}
              onPreviewUploadAttachment={vi.fn()}
              onOpenSkillMention={vi.fn()}
              onPreviewMentionArtifact={vi.fn()}
            />
          )
        })
      }
      await renderArtifact(artifact)
      await act(async () => {
        await Promise.allSettled(attempts)
      })

      if (layout === 'delayed publication') {
        // Exhaust the existing bounded retries before releasing real backend publication.
        for (let retry = 0; retry < 4; retry += 1) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(200)
            await Promise.allSettled(attempts)
          })
        }
        vi.useRealTimers()
        const claimId = registry.register({
          projectId: 'project-1',
          artifactSessionId: 'artifact-session-1',
          sessionId: 'session-1',
          runId: 'artifact-run-1',
          artifactVersionIds: [version.versionId],
          ...context
        })
        const [published] = await handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
        const ready = await resources.acquire(1, {
          source: 'artifact',
          projectId: 'project-1',
          fileId: published.artifactId!,
          mimeType: 'image/png',
          versionId: published.versionId
        })
        resources.release(1, { resourceId: ready.id })
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createCachedImageFetchResponse()))
        vi.stubGlobal(
          'URL',
          class extends URL {
            static createObjectURL = vi.fn(() => 'blob:published-plot')
            static revokeObjectURL = vi.fn()
          }
        )
        await renderArtifact(published)
        await act(async () => {
          await Promise.allSettled(attempts)
        })
        await waitFor(() =>
          expect(
            container.querySelector('img'),
            'Publication succeeded, so the mounted thumbnail must recover.'
          ).not.toBeNull()
        )
        return
      }

      expect(errors).toEqual([])
      expect(window.api.previewResources.acquire).not.toHaveBeenCalled()
      expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Preview generated file plot.png"]')
          ?.disabled
      ).toBe(true)
    }
  )
})
