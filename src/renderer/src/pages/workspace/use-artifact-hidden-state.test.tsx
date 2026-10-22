// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { usePreviewPathVisibility } from './use-artifact-hidden-state'
import type { ProjectFilesChangedEvent } from '../../../../shared/project-files'

it('removes loaded path content on hide even without a Project and rejects stale admission', async () => {
  let listener!: (event: ProjectFilesChangedEvent) => void
  let resolveOld!: (value: { id: string }) => void
  const acquire = vi
    .fn()
    .mockResolvedValueOnce({ id: 'initial' })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    .mockRejectedValueOnce(new Error('hidden'))
  window.api = {
    projectFiles: {
      getHiddenArtifactIds: vi.fn(),
      onChanged: (callback: typeof listener) => {
        listener = callback
        return () => undefined
      }
    },
    previewResources: { acquire, release: vi.fn().mockResolvedValue(undefined) }
  } as unknown as typeof window.api
  const Surface = (): React.JSX.Element =>
    usePreviewPathVisibility('/temporary/secret.txt') ? (
      <span>decoded private bytes</span>
    ) : (
      <span>unavailable</span>
    )
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Surface />))
    expect(container.textContent).toBe('decoded private bytes')
    await act(async () =>
      listener({
        projectId: 'project',
        sources: ['artifact'],
        kind: 'reset',
        artifactVisibilityChanged: true
      })
    )
    expect(container.textContent).toBe('unavailable')
    await act(async () =>
      listener({
        projectId: 'project',
        sources: ['artifact'],
        kind: 'reset',
        artifactVisibilityChanged: true
      })
    )
    await act(async () => resolveOld({ id: 'obsolete' }))
    expect(container.textContent).toBe('unavailable')
    expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'obsolete' })
  } finally {
    act(() => root.unmount())
  }
})
