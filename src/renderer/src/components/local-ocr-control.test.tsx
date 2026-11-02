// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocalOcrControl } from './local-ocr-control'
import type { LocalModelSnapshot } from '../../../shared/local-models'

it('supports compact downloads, routes cancel to OCR and stops polling on unmount', async () => {
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
    remove: vi.fn(async () => snapshot),
    setOcrLanguages: vi.fn(async () => snapshot)
  }
  const previous = window.api
  window.api = { ...previous, localModels: api }
  const container = document.createElement('div'),
    root = createRoot(container)
  document.body.appendChild(container)
  try {
    await act(async () => root.render(<LocalOcrControl compact />))
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

it('keeps language saves stable, rejects stale polls and offers missing packs for install', async () => {
  vi.useFakeTimers()
  const snapshot: LocalModelSnapshot = {
    availability: 'ready',
    recommendedRevision: 'ocr-v1',
    installedRevision: 'ocr-v1',
    downloadBytes: 256,
    installedBytes: 1024,
    hasFiles: true,
    inUse: false,
    transferredBytes: 0,
    updateAvailable: false,
    ocrLanguages: [
      {
        code: 'eng',
        label: 'English',
        selected: true,
        installed: true,
        downloadBytes: 0,
        installedBytes: 256,
        availability: 'ready',
        inUse: false
      },
      {
        code: 'deu',
        label: 'German',
        selected: true,
        installed: false,
        downloadBytes: 256,
        installedBytes: 0,
        availability: 'notInstalled',
        inUse: false
      }
    ],
    selectedOcrLanguages: ['eng', 'deu']
  }
  const api = {
    getSnapshot: vi.fn(async () => snapshot),
    install: vi.fn(async () => snapshot),
    cancel: vi.fn(async () => snapshot),
    remove: vi.fn(async () => snapshot),
    setOcrLanguages: vi.fn<typeof window.api.localModels.setOcrLanguages>()
  }
  const previous = window.api
  window.api = { ...previous, localModels: api }
  const container = document.createElement('div')
  const root = createRoot(container)
  document.body.appendChild(container)
  try {
    await act(async () => root.render(<LocalOcrControl />))
    expect(container.querySelector('button')?.textContent).toContain('Install')
    await act(async () => container.querySelector('button')!.click())
    expect(api.install).toHaveBeenCalledExactlyOnceWith('ocr')
    const german = container.querySelector<HTMLButtonElement>('[aria-label="German"]')!
    let finish!: (value: LocalModelSnapshot) => void
    api.setOcrLanguages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await act(async () => german.click())
    expect(api.setOcrLanguages).toHaveBeenCalledExactlyOnceWith(['eng'])
    expect(german.disabled).toBe(true)
    expect(german.className).not.toContain('opacity-50')
    expect(container.querySelector('fieldset')?.getAttribute('aria-busy')).toBe('true')
    // A poll started during the mutation must not restore the old selection afterwards.
    let finishPoll!: (value: LocalModelSnapshot) => void
    api.getSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPoll = resolve
        })
    )
    await act(async () => vi.advanceTimersByTimeAsync(2500))
    const updated = {
      ...snapshot,
      selectedOcrLanguages: ['eng' as const],
      ocrLanguages: snapshot.ocrLanguages!.map((language) => ({
        ...language,
        selected: language.code === 'eng'
      }))
    }
    await act(async () => finish(updated))
    await act(async () => finishPoll(snapshot))
    expect(german.getAttribute('aria-checked')).toBe('false')
    expect(german.disabled).toBe(false)
    api.setOcrLanguages.mockRejectedValueOnce(new Error('save failed'))
    await act(async () => german.click())
    expect(german.getAttribute('aria-checked')).toBe('false')
    expect(german.disabled).toBe(false)
    expect(container.textContent).toContain('Could not access local models')
  } finally {
    await act(async () => root.unmount())
    window.api = previous
    container.remove()
    vi.useRealTimers()
  }
})
