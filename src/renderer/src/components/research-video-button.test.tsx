// @vitest-environment jsdom
import { ResearchVideoProgressLine } from './research-video-progress'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import type { LocalModelSnapshot } from '../../../shared/local-models'
import type { ResearchVideoPresentationStatus } from '../../../shared/research-video-presentation'
import { ResearchVideoButton } from './research-video-button'
const { openPreview, removePreview } = vi.hoisted(() => ({
  openPreview: vi.fn(),
  removePreview: vi.fn()
}))
vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: {
    getState: () => ({ upsertAndActivateItem: openPreview, removeItem: removePreview })
  }
}))
let root: Root, container: HTMLDivElement
let snapshot: LocalModelSnapshot
let status: ResearchVideoPresentationStatus
const request = { projectId: 'p', sessionId: 'imported', branchId: 'branch' }
const api = {
  researchVideo: {
    status: vi.fn(async () => status),
    start: vi.fn(async () => (status = { progress: { phase: 'writing', startedAt: Date.now() } })),
    remove: vi.fn(async () => (status = {})),
    cancel: vi.fn(async () => {
      status = { progress: { phase: 'cancelled', startedAt: Date.now() } }
    })
  },
  localModels: {
    getSnapshot: vi.fn(async () => snapshot),
    install: vi.fn(async () => (snapshot = { ...snapshot, availability: 'installing' })),
    cancel: vi.fn(async () => (snapshot = { ...snapshot, availability: 'notInstalled' }))
  }
}
const click = async (name: string): Promise<void> => {
  const button = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === name || button.getAttribute('aria-label') === name
  )
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  await i18next.changeLanguage('en')
  status = {}
  snapshot = {
    availability: 'ready',
    downloadBytes: 128371600,
    installedBytes: 128371600,
    transferredBytes: 0,
    recommendedRevision: 'voice',
    installedRevision: 'voice',
    inUse: false,
    hasFiles: true,
    updateAvailable: false
  }
  vi.stubGlobal('api', api)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<ResearchVideoButton {...request} />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('starts directly from the session button without a chat or fork API, and supports cancellation', async () => {
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  await click('Generate research film')
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith(request)
  expect(document.body.textContent).toContain('Writing research film…')
  await click('Cancel')
  expect(api.researchVideo.cancel).toHaveBeenCalledExactlyOnceWith(request)
})

it('keeps the trigger in a loading state until the initial presentation status is known', async () => {
  let resolveStatus!: (next: ResearchVideoPresentationStatus) => void
  const pendingStatus = new Promise<ResearchVideoPresentationStatus>((resolve) => {
    resolveStatus = resolve
  })
  api.researchVideo.status.mockImplementationOnce(() => pendingStatus)

  await act(async () => root.render(<ResearchVideoButton {...request} sessionId="loading" />))

  const trigger = container.querySelector('button')!
  expect(trigger.textContent).toBe('Loading…')
  expect(trigger.disabled).toBe(true)

  await act(async () =>
    resolveStatus({
      result: {
        id: 'saved',
        title: 'Saved research',
        duration: 10,
        playerPath: '/saved.html',
        sourcePath: '/saved.zip'
      }
    })
  )

  expect(trigger.textContent).toBe('View research film')
  expect(trigger.disabled).toBe(false)
})

it('keeps the trigger loading after a status failure until a retry succeeds', async () => {
  api.researchVideo.status.mockRejectedValueOnce(new Error('temporary status failure'))

  await act(async () => root.render(<ResearchVideoButton {...request} sessionId="retry" />))

  const trigger = container.querySelector('button')!
  expect(trigger.textContent).toBe('Loading…')
  expect(trigger.disabled).toBe(true)

  status = {
    result: {
      id: 'saved',
      title: 'Saved research',
      duration: 10,
      playerPath: '/saved.html',
      sourcePath: '/saved.zip'
    }
  }
  await act(async () => vi.advanceTimersByTimeAsync(750))

  expect(trigger.textContent).toBe('View research film')
  expect(trigger.disabled).toBe(false)
})

it('explains a blocked source and enables generation when a completed reply becomes available', async () => {
  status = { generationBlock: 'awaiting-reply' }
  await act(async () => vi.advanceTimersByTimeAsync(750))
  const trigger = container.querySelector('button')!
  expect(trigger.disabled).toBe(true)
  expect(trigger.title).toBe('Wait for a completed response before generating.')
  await act(async () => trigger.click())
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  status = {}
  await act(async () => vi.advanceTimersByTimeAsync(750))
  expect(trigger.disabled).toBe(false)
  await click('Generate research film')
  expect(api.researchVideo.start).toHaveBeenCalledOnce()
})

it('keeps saved playback available while blocking regeneration during a live response', async () => {
  status = {
    generationBlock: 'busy',
    result: {
      id: 'saved',
      title: 'Saved research',
      duration: 10,
      playerPath: '/saved.html',
      sourcePath: '/saved.zip'
    }
  }
  await act(async () => vi.advanceTimersByTimeAsync(750))
  await click('View research film')
  expect(document.body.textContent).toContain(
    'Wait for the current response to finish before generating.'
  )
  const regenerate = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Generate again'
  )!
  expect(regenerate.disabled).toBe(true)
  await click('Play research film')
  expect(openPreview).toHaveBeenCalledWith(expect.objectContaining({ path: '/saved.html' }))
  expect(api.researchVideo.start).not.toHaveBeenCalled()
})
it('offers installation inline and starts automatically only after resources are ready', async () => {
  snapshot = {
    ...snapshot,
    availability: 'notInstalled',
    hasFiles: false,
    installedRevision: undefined
  }
  await click('Generate research film')
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  expect(api.localModels.install).not.toHaveBeenCalled()
  await click('Install and generate')
  expect(api.localModels.install).toHaveBeenCalledExactlyOnceWith('research-narration')
  await act(async () => vi.advanceTimersByTimeAsync(750))
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  snapshot = { ...snapshot, availability: 'ready' }
  await act(async () => vi.advanceTimersByTimeAsync(750))
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith(request)
})
it('reopens a persisted player and stops polling after leaving the session', async () => {
  status = {
    result: {
      id: 'job',
      title: 'Rainfall',
      duration: 5,
      playerPath: '/data/player.html',
      sourcePath: '/data/sources.zip'
    }
  }
  await act(async () => vi.advanceTimersByTimeAsync(750))
  expect(container.querySelectorAll('button')).toHaveLength(1)
  await click('View research film')
  await click('Play research film')
  expect(openPreview).toHaveBeenCalledWith(
    expect.objectContaining({
      path: '/data/player.html',
      name: 'Rainfall.html',
      source: 'local',
      sessionId: 'imported',
      format: 'html'
    })
  )
  await act(async () => root.render(null))
  const count = api.researchVideo.status.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(api.researchVideo.status).toHaveBeenCalledTimes(count)
})

it('allows the shared dialog close control to hide progress without cancelling generation', async () => {
  await click('Generate research film')
  const close = document.querySelector<HTMLButtonElement>(
    '[role="dialog"] button[aria-label="Close"]'
  )
  expect(close).not.toBeNull()
  expect(close?.disabled).toBe(false)
  await act(async () => close!.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(api.researchVideo.cancel).not.toHaveBeenCalled()
  await click('View generation progress')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(api.researchVideo.start).toHaveBeenCalledTimes(1)
})

it('checks for an existing player before generating, even before the next status poll', async () => {
  status = {
    result: {
      id: 'existing',
      title: 'Existing rainfall explanation',
      duration: 94,
      playerPath: '/data/existing.html',
      sourcePath: '/data/existing.zip'
    }
  }
  snapshot = {
    ...snapshot,
    availability: 'notInstalled',
    hasFiles: false,
    installedRevision: undefined
  }
  await click('Generate research film')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Existing rainfall explanation'
  )
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  expect(api.localModels.getSnapshot).not.toHaveBeenCalled()
  expect(api.localModels.install).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('1:34')
  expect(dialog.textContent).toContain('English narration')
  expect(dialog.querySelectorAll('button[data-variant="default"]')).toHaveLength(1)
  expect(dialog.querySelectorAll('button[aria-label="Close"]')).toHaveLength(1)
  expect(document.body.textContent).not.toContain('Open source package')
  await click('Play research film')
  expect(openPreview).toHaveBeenCalledWith(expect.objectContaining({ path: '/data/existing.html' }))
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  await click('View research film')
  await click('Generate again')
  expect(api.localModels.getSnapshot).not.toHaveBeenCalled()
  await click('Start generation')
  expect(api.localModels.getSnapshot).toHaveBeenCalledExactlyOnceWith('research-narration')
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Install and generate')
})

it('requires confirmation and permits cancellation before starting a replacement', async () => {
  status = {
    result: {
      id: 'existing',
      title: 'Rainfall',
      duration: 94,
      playerPath: '/data/existing.html',
      sourcePath: '/data/existing.zip'
    }
  }
  await act(async () => vi.advanceTimersByTimeAsync(750))
  await click('View research film')
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  await click('Generate again')
  expect(
    document.querySelector('[role="group"][aria-label="Generate again?"]')?.textContent
  ).toContain('several minutes')
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  expect(api.localModels.getSnapshot).not.toHaveBeenCalled()
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  await click('Cancel')
  expect(document.querySelector('[role="group"][aria-label="Generate again?"]')).toBeNull()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  await click('Generate again')
  await click('Start generation')
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith(request)
})

it('offers installation for a transferred narration revision and waits for the current revision', async () => {
  snapshot = { ...snapshot, installedRevision: 'other-platform', updateAvailable: true }
  await click('Generate research film')
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  await click('Install and generate')
  snapshot = { ...snapshot, availability: 'ready' }
  await act(async () => vi.advanceTimersByTimeAsync(750))
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  await click('Install and generate')
  snapshot = {
    ...snapshot,
    availability: 'ready',
    installedRevision: 'voice',
    updateAvailable: false
  }
  await act(async () => vi.advanceTimersByTimeAsync(750))
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith(request)
})

it('requires inline confirmation to delete a film and closes its preview after deletion', async () => {
  status = {
    result: {
      id: 'saved',
      title: 'Saved',
      duration: 4,
      playerPath: '/film.html',
      sourcePath: '/film.zip'
    }
  }
  await act(async () => vi.advanceTimersByTimeAsync(750))
  await click('View research film')
  const openMenu = async (): Promise<void> => {
    const trigger = document.querySelector('[aria-label="More actions"]')!
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((x) =>
      x.textContent?.includes('Delete research film')
    )!
    expect(item).toBeDefined()
    await act(async () => (item as HTMLElement).click())
  }
  await openMenu()
  expect(api.researchVideo.remove).not.toHaveBeenCalled()
  expect(document.activeElement?.textContent).toBe('Cancel')
  await click('Cancel')
  expect(api.researchVideo.remove).not.toHaveBeenCalled()
  await openMenu()
  await click('Delete research film')
  expect(api.researchVideo.remove).toHaveBeenCalledExactlyOnceWith(request)
  expect(removePreview).toHaveBeenCalledWith('research-video-saved-player')
  expect(document.body.textContent).toContain('Generate research film')
  expect(api.researchVideo.start).not.toHaveBeenCalled()
})

it.each(['failed', 'cancelled'] as const)(
  'freezes elapsed time after %s, including reopening',
  async (phase) => {
    await click('Generate research film')
    const startedAt = status.progress!.startedAt
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(document.body.textContent).toContain('Elapsed: 3 s')
    status = { progress: { phase, startedAt, endedAt: startedAt + 3000 } }
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(document.body.textContent).toContain('Elapsed: 3 s')
    await act(async () => root.render(<ResearchVideoProgressLine progress={status.progress!} />))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(document.body.textContent).toContain('Elapsed: 3 s')
  }
)

it('blocks known failures before narration download and rechecks when the entry is reopened', async () => {
  snapshot = { ...snapshot, availability: 'notInstalled' }
  status = { preflightError: 'Runtime unavailable' }
  await click('Generate research film')
  expect(api.researchVideo.status).toHaveBeenCalledWith({ ...request, checkReadiness: true })
  expect(document.body.textContent).toContain('Runtime unavailable')
  expect(document.querySelector('[data-notice-level="warning"]')).not.toBeNull()
  expect(document.querySelector('[data-notice-level="info"]')).toBeNull()
  expect(document.body.textContent).not.toContain('Install and generate')
  expect(api.localModels.install).not.toHaveBeenCalled()
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  status = {}
  await click('Generate research film')
  expect(document.body.textContent).toContain('Install and generate')
  status = { preflightError: 'Model unavailable' }
  await click('Install and generate')
  expect(api.localModels.install).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Model unavailable')
})

it('still plays an existing film when generation preflight is blocked', async () => {
  status = {
    result: {
      id: 'saved',
      title: 'Saved film',
      duration: 5,
      playerPath: '/player.html',
      sourcePath: '/source.zip'
    },
    preflightError: 'Runtime unavailable'
  }
  await click('Generate research film')
  await click('Play research film')
  expect(openPreview).toHaveBeenCalledOnce()
  expect(api.researchVideo.start).not.toHaveBeenCalled()
})
