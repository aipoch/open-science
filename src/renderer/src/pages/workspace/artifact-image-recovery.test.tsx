// @vitest-environment jsdom
import { act, type ElementType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  WEB_EVENT_SURFACE_ATTRIBUTE
} from '../../../../shared/web-event-connection'
import type { MessageArtifact } from './session-message-artifact-reference'
import { ArtifactPreview } from './artifact-preview'
import { SessionMessageMarkdown } from './SessionMessageMarkdown'

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  PresentedAgentMarkdown: ({ components }: { components: Record<string, ElementType> }) => {
    const Image = components['session-artifact-image']
    return <Image artifact_ref="version-1" alt_text="Chart" />
  }
}))

const artifact: MessageArtifact = {
  id: 'version-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  isPublished: true,
  kind: 'managed-file',
  path: '/managed/chart.png',
  name: 'chart.png',
  mimeType: 'image/png',
  size: 65 * 1024 * 1024,
  resolvedProjectId: 'project-1',
  resolvedSessionId: 'session-1'
}
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  let generation = 0
  window.api = {
    previewResources: {
      acquire: vi.fn(async () => ({
        id: `resource-${++generation}`,
        url: `/preview/resource-${generation}`,
        size: artifact.size,
        mimeType: 'image/png',
        version: 1
      })),
      release: vi.fn().mockResolvedValue(undefined)
    }
  } as unknown as Window['api']
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
  vi.unstubAllGlobals()
})

it.each(['markdown', 'thumbnail'] as const)(
  'retries a revoked %s image after reconnect without remounting the consumer',
  async (surface) => {
    await act(async () =>
      root.render(
        surface === 'markdown' ? (
          <SessionMessageMarkdown
            content="![Chart](chart.png)"
            artifacts={[artifact]}
            onPreviewArtifact={vi.fn()}
            onPreviewArtifactModal={vi.fn()}
          />
        ) : (
          <ArtifactPreview artifact={artifact} projectId="project-1" managedFileId="artifact-1" />
        )
      )
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/preview/resource-1')
    act(() => {
      window.dispatchEvent(
        new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, {
          detail: { phase: 'reconnecting' }
        })
      )
    })
    // The browser reports a failed request to the revoked capability while disconnected.
    await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, {
          detail: { phase: 'live' }
        })
      )
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/preview/resource-2')
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
  }
)
