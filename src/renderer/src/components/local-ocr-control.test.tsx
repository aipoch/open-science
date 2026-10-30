// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocalOcrControl } from './local-ocr-control'
import type { LocalModelSnapshot } from '../../../shared/local-models'

it('downloads only after a click, routes cancel to OCR and stops polling on unmount', async () => {
  vi.useFakeTimers()
  let snapshot: LocalModelSnapshot = {
    availability: 'notInstalled',
    recommendedRevision: 'ocr-v1',
    downloadBytes: 1024,
    installedBytes: 0,
    hasFiles: false,
    inUse: false,
    transferredBytes: 0,
    updateAvailable: false
  }
  const api = {
    getSnapshot: vi.fn(async () => snapshot),
    install: vi.fn(async () => (snapshot = { ...snapshot, availability: 'installing' })),
    cancel: vi.fn(async () => (snapshot = { ...snapshot, availability: 'notInstalled' })),
    remove: vi.fn(async () => snapshot)
  }
  const previous = window.api
  window.api = { ...previous, localModels: api }
  const container = document.createElement('div'),
    root = createRoot(container)
  document.body.appendChild(container)
  try {
    await act(async () => root.render(<LocalOcrControl />))
    expect(api.install).not.toHaveBeenCalled()
    await act(async () => container.querySelector('button')!.click())
    expect(api.install).toHaveBeenCalledExactlyOnceWith('ocr')
    await act(async () => container.querySelector('button')!.click())
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith('ocr')
  } finally {
    await act(async () => root.unmount())
    const calls = api.getSnapshot.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.getSnapshot).toHaveBeenCalledTimes(calls)
    window.api = previous
    container.remove()
    vi.useRealTimers()
  }
})
