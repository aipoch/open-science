// @vitest-environment jsdom
import { ResearchVideoProgressLine } from './research-video-progress'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settings-store'
import { i18next } from '@/i18n'
import type { LocalModelSnapshot } from '../../../shared/local-models'
import type {
  ResearchVideoStatusRequest,
  ResearchVideoPresentationStatus
} from '../../../shared/research-video-presentation'
import { ResearchVideoButton } from './research-video-button'
import { RESEARCH_FILM_MODEL_TIMEOUT_MESSAGE } from '../../../shared/research-video-presentation'
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
    status: vi.fn<(scope?: ResearchVideoStatusRequest) => Promise<ResearchVideoPresentationStatus>>(
      async () => status
    ),
    start: vi.fn(
      async (): Promise<ResearchVideoPresentationStatus> =>
        (status = { progress: { phase: 'writing', startedAt: Date.now() } })
    ),
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
  api.researchVideo.status.mockImplementation(async () => status)
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
it('chooses a mode before starting without a chat or fork API, and supports cancellation', async () => {
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  await click('Generate research film')
  await click('Start generation')
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith(request)
  expect(document.body.textContent).toContain('Writing research film…')
  await click('Run in background')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(api.researchVideo.cancel).not.toHaveBeenCalled()
  await click('View generation progress')
  expect(document.body.textContent).toContain('Writing research film…')
  expect(api.researchVideo.start).toHaveBeenCalledTimes(1)
  await click('Cancel')
  expect(api.researchVideo.cancel).toHaveBeenCalledExactlyOnceWith(request)
})

it('continues a checkpoint without waiting for the narration model', async () => {
  status = { canResume: true, preflightError: 'Runtime unavailable' }
  snapshot = { ...snapshot, availability: 'notInstalled' }
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  await click('Generate research film')
  api.localModels.getSnapshot.mockClear()
  await click('Retry')
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith({ ...request, resume: true })
  expect(api.localModels.getSnapshot).not.toHaveBeenCalled()
})

it.each([
  [RESEARCH_FILM_MODEL_TIMEOUT_MESSAGE, 'Model request timed out. Try again.'],
  [
    'Restricted inference was cancelled.',
    'The model stopped before completing this step. Try again.'
  ],
  [
    'Research film generation stopped before completing (refusal). Try again or select another model.',
    'The model declined to generate this content.'
  ],
  [
    'Research film readiness check timed out. Try again.',
    'Generation preparation timed out. Try again.'
  ],
  ['Research film model setup timed out. Try again.', 'Model setup timed out. Try again.'],
  [
    'Research film generation reached the model output token limit. Increase the model output limit or select another model and try again.',
    'The model reached its output limit. Increase the limit or select another model.'
  ],
  [
    'Film is still waiting for the disk. Try again after the disk responds.',
    'Waiting for storage. Try again after it responds.'
  ]
])('explains %s without losing diagnostic details', async (error, summary) => {
  status = { error, progress: { phase: 'failed', startedAt: Date.now() } }
  await click('Generate research film')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(summary)
  expect(document.querySelector('details pre')?.textContent).toBe(error)
})

it.each([
  ['research-explanation', false],
  ['research-explanation', true],
  ['operation-replay', false],
  ['operation-replay', true]
] as const)('retries %s with checkpoint=%s', async (mode, canResume) => {
  status = {
    canResume,
    error: RESEARCH_FILM_MODEL_TIMEOUT_MESSAGE,
    progress: { phase: 'failed', startedAt: Date.now() }
  }
  await act(async () => root.render(<ResearchVideoButton {...request} mode={mode} />))
  await click('Generate research film')
  await click('Retry')
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith({
    ...request,
    ...(mode === 'operation-replay' ? { mode } : {}),
    ...(canResume ? { resume: true } : {})
  })
})

it('distinguishes a status read failure while preserving a generation failure', async () => {
  api.researchVideo.status.mockRejectedValue(new Error('Status unavailable'))
  await click('Generate research film')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not retrieve generation status.'
  )
  api.researchVideo.status.mockImplementation(async () => status)
  status = {
    error: RESEARCH_FILM_MODEL_TIMEOUT_MESSAGE,
    progress: { phase: 'failed', startedAt: Date.now() }
  }
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  api.researchVideo.status.mockRejectedValue(new Error('Status unavailable'))
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Model request timed out. Try again.'
  )
})

it.each([false, true])(
  'handles an admission status read failure (retry=%s) without starting a film',
  async (retry) => {
    if (retry)
      status = {
        canResume: true,
        error: RESEARCH_FILM_MODEL_TIMEOUT_MESSAGE,
        progress: { phase: 'failed', startedAt: Date.now() }
      }
    await click('Generate research film')
    api.researchVideo.status.mockRejectedValueOnce(new Error('Status unavailable'))
    await click(retry ? 'Retry' : 'Start generation')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      retry ? 'Model request timed out. Try again.' : 'Could not retrieve generation status.'
    )
    expect(api.researchVideo.start).not.toHaveBeenCalled()
  }
)

it('keeps raw generation errors in collapsed details and copies the full message', async () => {
  const error = JSON.stringify(
    [{ code: 'invalid_union', message: 'multiple errors'.repeat(300) }],
    null,
    2
  )
  status = {
    canResume: true,
    filmStep: 2,
    progress: { phase: 'failed', startedAt: Date.now() },
    error
  }
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal(
    'navigator',
    Object.create(window.navigator, { clipboard: { value: { writeText } } })
  )
  await click('Generate research film')
  const details = document.querySelector('dialog details, [role="dialog"] details')!
  expect(details.hasAttribute('open')).toBe(false)
  expect(document.querySelector('[role="alert"]')?.textContent).not.toContain(error)
  const copy = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === 'Copy error'
  )!
  expect(copy.closest('details')).toBeNull()
  await click('Copy error')
  expect(writeText).toHaveBeenCalledExactlyOnceWith(error)
  expect(copy.textContent).toBe('Copied')
  expect(details.hasAttribute('open')).toBe(false)
  await act(async () => details.querySelector('summary')!.click())
  expect(details.querySelector('pre')?.textContent).toBe(error)
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

it('opens Film after a status RPC never returns without stacking requests', async () => {
  let resolveStatus!: (next: ResearchVideoPresentationStatus) => void
  api.researchVideo.status.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStatus = resolve
      })
  )
  await act(async () => root.render(<ResearchVideoButton {...request} sessionId="stalled" />))
  const stalledModeCalls = (): number =>
    api.researchVideo.status.mock.calls.filter(([scope]) => scope?.mode !== 'operation-replay')
      .length
  const calls = stalledModeCalls()
  await act(async () => vi.advanceTimersByTimeAsync(120_000))
  expect(container.querySelector('button')?.disabled).toBe(false)
  await click('Generate research film')
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  expect(stalledModeCalls()).toBe(calls)
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  await act(async () => resolveStatus({}))
  await click('Start generation')
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith({
    ...request,
    sessionId: 'stalled'
  })
})

it('allows opening a failed status read and backs off until a retry succeeds', async () => {
  api.researchVideo.status.mockRejectedValueOnce(new Error('temporary status failure'))

  await act(async () => root.render(<ResearchVideoButton {...request} sessionId="retry" />))

  const trigger = container.querySelector('button')!
  expect(trigger.textContent).toBe('Generate research film')
  expect(trigger.disabled).toBe(false)

  status = {
    result: {
      id: 'saved',
      title: 'Saved research',
      duration: 10,
      playerPath: '/saved.html',
      sourcePath: '/saved.zip'
    }
  }
  await act(async () => vi.advanceTimersByTimeAsync(5_000))

  expect(trigger.textContent).toBe('View research film')
  expect(trigger.disabled).toBe(false)
})

it('explains a blocked source and enables generation when a completed reply becomes available', async () => {
  status = { generationBlock: 'awaiting-reply' }
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  const trigger = container.querySelector('button')!
  expect(trigger.disabled).toBe(false)
  await act(async () => trigger.click())
  expect(document.body.textContent).toContain('Wait for a completed response before generating.')
  expect(
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Start generation')
  ).toBeUndefined()
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  status = {}
  await act(async () => vi.advanceTimersByTimeAsync(5_000))
  expect(trigger.disabled).toBe(false)
  await click('Start generation')
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
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
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
it('hides the previous replay during regeneration and plays the new result on completion', async () => {
  const previous = {
    id: 'previous',
    title: 'Previous operation replay',
    duration: 10,
    playerPath: '/previous.html',
    sourcePath: '/previous.zip'
  }
  status = { result: previous }
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  await click('View research film')
  await click('Operation replay')
  expect(document.querySelector('[aria-label="Research film ready"]')?.textContent).toContain(
    previous.title
  )
  api.researchVideo.start.mockImplementationOnce(
    async () =>
      (status = {
        result: previous,
        progress: { phase: 'writing', startedAt: Date.now() }
      })
  )
  await click('Generate again')
  await click('Start generation')
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith({
    ...request,
    mode: 'operation-replay'
  })
  expect(document.body.textContent).toContain('Writing research film…')
  expect(document.querySelector('[aria-label="Research film ready"]')).toBeNull()
  await click('Run in background')
  await click('View generation progress')
  expect(document.querySelector('[aria-label="Research film ready"]')).toBeNull()

  status = {
    result: { ...previous, id: 'new', title: 'New operation replay', playerPath: '/new.html' },
    progress: { phase: 'completed', startedAt: Date.now() }
  }
  await act(async () => vi.advanceTimersByTimeAsync(750))
  expect(document.querySelector('[aria-label="Research film ready"]')?.textContent).toContain(
    'New operation replay'
  )
  await click('Play research film')
  expect(openPreview).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ path: '/new.html' })
  )
})

it('submits the installation and film as one scoped request and restores progress on return', async () => {
  snapshot = { ...snapshot, availability: 'notInstalled', installedRevision: undefined }
  await click('Generate research film')
  await click('Start generation')
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  const download = { narrationDownload: { ...snapshot, availability: 'installing' as const } }
  api.researchVideo.start.mockImplementationOnce(async () => (status = download))
  await click('Install and generate')
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith({
    ...request,
    installNarration: true
  })
  await act(async () => root.render(null))
  status = {}
  await act(async () => root.render(<ResearchVideoButton {...request} sessionId="other" />))
  expect(container.textContent).toContain('Generate research film')
  status = download
  await act(async () => root.render(<ResearchVideoButton {...request} />))
  await click('View generation progress')
  await click('Cancel')
  expect(api.researchVideo.cancel).toHaveBeenCalledExactlyOnceWith(request)
  expect(api.researchVideo.start).toHaveBeenCalledTimes(1)
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
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
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
  await click('Start generation')
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
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
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

it('requires installation consent for a transferred narration revision', async () => {
  snapshot = { ...snapshot, installedRevision: 'other-platform', updateAvailable: true }
  await click('Generate research film')
  await click('Start generation')
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  await click('Install and generate')
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith({
    ...request,
    installNarration: true
  })
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
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
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
    await click('Start generation')
    const startedAt = status.progress!.startedAt
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(document.body.textContent).toContain('Elapsed: 3 s')
    status = { filmStep: 2, progress: { phase, startedAt, endedAt: startedAt + 3000 } }
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(document.body.textContent).toContain('Elapsed: 3 s')
    expect(document.body.textContent).toContain(
      phase === 'failed' ? 'Research video failed' : 'Research video cancelled'
    )
    expect(document.body.textContent).not.toContain('Writing research film…')
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
  await click('Close')
  await click('Generate research film')
  await click('Start generation')
  expect(document.body.textContent).toContain('Install and generate')
  api.researchVideo.start.mockResolvedValueOnce({ preflightError: 'Model unavailable' })
  await click('Install and generate')
  expect(api.localModels.install).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Model unavailable')
})

it('opens model settings from the missing-model warning without starting a film', async () => {
  await act(async () => {
    await i18next.changeLanguage('zh-Hans')
  })
  status = { preflightError: 'Select a model in Settings before generating a research film.' }
  await click('生成研究短片')
  expect(document.querySelector('[data-notice-level="warning"]')?.textContent).toBe(
    '生成研究短片前，请在设置中选择模型。'
  )
  await click('选择模型')
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(useSettingsStore.getState().pendingSettingsIntent?.route.panel).toBe('model')
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  useSettingsStore.getState().closeSettings()
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

it('allows replay selection when explanation is blocked without starting on selection', async () => {
  status = { generationBlock: 'empty' }
  api.researchVideo.status.mockImplementation(async (scope?: { mode?: string }) =>
    scope?.mode === 'operation-replay' && !status.progress ? {} : status
  )
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  await click('Generate research film')
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  expect(api.localModels.getSnapshot).not.toHaveBeenCalled()
  expect(document.querySelector('[aria-label="Film mode"]')).not.toBeNull()
  expect(api.researchVideo.status).toHaveBeenCalledWith({ ...request, mode: 'operation-replay' })
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog).not.toBeNull()
  const readsBeforeSelection = api.researchVideo.status.mock.calls.length
  await click('Operation replay')
  expect(document.querySelector('[role="dialog"]')).toBe(dialog)
  expect(api.researchVideo.status).toHaveBeenCalledTimes(readsBeforeSelection)
  expect(api.researchVideo.start).not.toHaveBeenCalled()
  await click('Start generation')
  expect(api.researchVideo.status).toHaveBeenCalledWith({
    ...request,
    mode: 'operation-replay',
    checkReadiness: true
  })
  expect(api.researchVideo.start).toHaveBeenCalledExactlyOnceWith({
    ...request,
    mode: 'operation-replay'
  })
  await click('Cancel')
  expect(api.researchVideo.cancel).toHaveBeenCalledWith({ ...request, mode: 'operation-replay' })
  api.researchVideo.status.mockImplementation(async () => status)
})

it('backs off idle reads and immediately resumes polling for generation', async () => {
  api.researchVideo.status.mockClear()
  await act(async () => vi.advanceTimersByTimeAsync(29_999))
  expect(api.researchVideo.status).not.toHaveBeenCalled()
  await click('Generate research film')
  await click('Start generation')
  api.researchVideo.status.mockClear()
  await act(async () => vi.advanceTimersByTimeAsync(750))
  expect(api.researchVideo.status).toHaveBeenCalled()
})

it('backs off failed status reads, preserves the player, and clears read errors on recovery', async () => {
  status = {
    result: {
      id: 'saved',
      title: 'Saved film',
      duration: 12,
      playerPath: '/saved.html',
      sourcePath: '/sources.zip'
    }
  }
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  await click('View research film')
  api.researchVideo.status.mockRejectedValue(new Error('Film status connection lost'))
  await act(async () => vi.advanceTimersByTimeAsync(5_000))
  expect(document.body.textContent).toContain('Film status connection lost')
  expect(document.body.textContent).toContain('Saved film')
  api.researchVideo.status.mockClear()
  await act(async () => vi.advanceTimersByTimeAsync(4_999))
  expect(api.researchVideo.status).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(api.researchVideo.status).toHaveBeenCalledTimes(2)
  api.researchVideo.status.mockClear()
  await act(async () => vi.advanceTimersByTimeAsync(9_999))
  expect(api.researchVideo.status).not.toHaveBeenCalled()
  api.researchVideo.status.mockImplementation(async () => status)
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(document.body.textContent).not.toContain('Film status connection lost')
  expect(document.body.textContent).toContain('Saved film')
})

it('clears a recovered dialog readiness read without clearing a generation failure', async () => {
  api.researchVideo.status.mockImplementation(async (scope) => {
    if (scope?.checkReadiness) throw new Error('Readiness connection lost')
    return status
  })
  await click('Generate research film')
  expect(document.body.textContent).toContain('Readiness connection lost')
  api.researchVideo.status.mockImplementation(async () => status)
  await act(async () => vi.advanceTimersByTimeAsync(5_000))
  expect(document.body.textContent).not.toContain('Readiness connection lost')

  api.researchVideo.start.mockRejectedValueOnce(new Error('Generation request failed'))
  await click('Start generation')
  expect(document.body.textContent).toContain('Generation request failed')
  await act(async () => vi.advanceTimersByTimeAsync(5_000))
  expect(document.body.textContent).toContain('Generation request failed')
})
