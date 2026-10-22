// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { ArtifactSaveProgress } from '../../../../shared/file-save'
import { useArtifactSaveProgress } from './use-artifact-save-progress'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('ignores a late poll and cancel rejection from a previous transfer', async () => {
  let oldProgress!: (progress: ArtifactSaveProgress) => void
  let rejectCancel!: (error: Error) => void
  window.api = {
    getArtifactSaveProgress: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldProgress = resolve
          })
      )
      .mockResolvedValue({ phase: 'running', completedFiles: 2, totalFiles: 4 }),
    cancelArtifactSave: vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectCancel = reject
        })
    )
  } as unknown as Window['api']
  let transfer!: ReturnType<typeof useArtifactSaveProgress>
  const Fixture = (): null => {
    transfer = useArtifactSaveProgress()
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<Fixture />)
    })
    await act(async () => {
      transfer.begin(100)
    })
    let cancelling!: Promise<void>
    act(() => {
      cancelling = transfer.cancel()
    })
    act(() => transfer.end())
    await act(async () => {
      transfer.begin(4)
    })
    await act(async () => {
      oldProgress({ phase: 'running', completedFiles: 99, totalFiles: 100 })
      rejectCancel(new Error('stale rejection'))
      await cancelling
    })
    expect(transfer.progress).toEqual({ phase: 'running', completedFiles: 2, totalFiles: 4 })
    expect(transfer.cancelPending).toBe(false)
    expect(transfer.cancelError).toBe(false)
  } finally {
    act(() => root.unmount())
  }
})
