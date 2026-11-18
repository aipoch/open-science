import { watch } from 'node:fs'
import type { Locator, Page } from 'playwright'

// These are presentation-opportunity proxies in a foreground renderer, not hardware FPS or
// compositor presentation timestamps. Store only numbers/identities during the measured phase.
type TimedDuration = { startTime: number; duration: number }
type UiInputTiming = TimedDuration & {
  name: string
  inputDelayMs: number
  processingMs: number
  interactionId: number
}
type CommittedRevision = {
  receivedAt: number
  revision: number
  originClientId: string
}
type SessionUiProbeState = {
  label: string
  startedAt: number
  timeOrigin: number
  stop(): void
  frameGaps: TimedDuration[]
  longTasks: TimedDuration[]
  eventTimings: UiInputTiming[]
  committedRevisions: CommittedRevision[]
  rendererUpdateReceipts: CommittedRevision[]
  invalidReasons: string[]
  supportedEntryTypes: string[]
  viewport: { width: number; height: number; devicePixelRatio: number }
}

export type SessionUiProbeResult = Omit<SessionUiProbeState, 'stop'> & {
  endedAt: number
  durationMs: number
  frameGapSummary: {
    count: number
    medianMs: number | null
    p95Ms: number | null
    maxMs: number | null
    over50Ms: number
    over100Ms: number
  }
  longTaskSummary: { count: number; totalMs: number; over50BlockingMs: number }
}

const PROBE_KEY = '__sessionUiPerformanceProbe'
const ACTION_KEY = '__sessionUiPerformanceAction'

export const assertSessionUiForeground = async (page: Page): Promise<void> => {
  const foreground = await page.evaluate(() => ({
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus()
  }))
  if (!foreground.visible || !foreground.focused)
    throw new Error(
      `UI measurement requires a visible focused window: ${JSON.stringify(foreground)}`
    )
}

export const startSessionUiProbe = async (
  page: Page,
  options: { sessionId: string; label: string }
): Promise<void> => {
  await assertSessionUiForeground(page)
  await page.evaluate(
    ({ key, options }) => {
      if (Reflect.get(window, key)) throw new Error('A Session UI probe is already running.')
      const supportedEntryTypes = [...PerformanceObserver.supportedEntryTypes]
      const state: SessionUiProbeState = {
        label: options.label,
        startedAt: performance.now(),
        timeOrigin: performance.timeOrigin,
        stop: () => undefined,
        frameGaps: [],
        longTasks: [],
        eventTimings: [],
        committedRevisions: [],
        rendererUpdateReceipts: [],
        invalidReasons: [],
        supportedEntryTypes,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          devicePixelRatio
        }
      }
      const invalidate = (reason: string): void => {
        if (!state.invalidReasons.includes(reason)) state.invalidReasons.push(reason)
      }
      const checkForeground = (): void => {
        if (document.visibilityState !== 'visible') invalidate('document-hidden')
        if (!document.hasFocus()) invalidate('window-unfocused')
        if (innerWidth !== state.viewport.width || innerHeight !== state.viewport.height)
          invalidate('viewport-changed')
      }
      const blur = (): void => invalidate('window-blurred')
      let previous: number | undefined
      let animationFrame = 0
      const sample = (now: number): void => {
        checkForeground()
        if (previous !== undefined)
          state.frameGaps.push({ startTime: previous, duration: now - previous })
        previous = now
        animationFrame = requestAnimationFrame(sample)
      }
      const consumeTasks = (entries: PerformanceEntry[]): void => {
        for (const { startTime, duration } of entries)
          if (startTime >= state.startedAt) state.longTasks.push({ startTime, duration })
      }
      const consumeEvents = (entries: PerformanceEntry[]): void => {
        for (const entry of entries) {
          const timing = entry as PerformanceEntry & {
            processingStart: number
            processingEnd: number
            interactionId?: number
          }
          if (entry.startTime < state.startedAt) continue
          state.eventTimings.push({
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            inputDelayMs: timing.processingStart - entry.startTime,
            processingMs: timing.processingEnd - timing.processingStart,
            interactionId: timing.interactionId ?? 0
          })
        }
      }
      const tasks = supportedEntryTypes.includes('longtask')
        ? new PerformanceObserver((list) => consumeTasks(list.getEntries()))
        : undefined
      tasks?.observe({ type: 'longtask' })
      const events = supportedEntryTypes.includes('event')
        ? new PerformanceObserver((list) => consumeEvents(list.getEntries()))
        : undefined
      // Event Timing entries below the browser threshold may be absent; absence is not zero delay.
      events?.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit)
      const removeUpdated = window.api.sessions.onUpdated(({ session, originClientId }) => {
        if (session.id !== options.sessionId) return
        const receipts = originClientId.startsWith('main:')
          ? state.committedRevisions
          : state.rendererUpdateReceipts
        receipts.push({
          receivedAt: performance.now(),
          revision: session.revision ?? 0,
          originClientId
        })
      })
      window.addEventListener('blur', blur)
      document.addEventListener('visibilitychange', checkForeground)
      animationFrame = requestAnimationFrame(sample)
      state.stop = () => {
        checkForeground()
        cancelAnimationFrame(animationFrame)
        if (tasks) consumeTasks(tasks.takeRecords())
        if (events) consumeEvents(events.takeRecords())
        tasks?.disconnect()
        events?.disconnect()
        removeUpdated()
        window.removeEventListener('blur', blur)
        document.removeEventListener('visibilitychange', checkForeground)
      }
      Reflect.set(window, key, state)
    },
    { key: PROBE_KEY, options }
  )
  // Arm the sampling loop before an action can block the renderer. This waiting time is not
  // included in the separately captured click/input latency.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await assertSessionUiForeground(page)
}

export const stopSessionUiProbe = async (page: Page): Promise<SessionUiProbeResult> => {
  const raw = await page.evaluate((key) => {
    const state = Reflect.get(window, key) as SessionUiProbeState | undefined
    if (!state) throw new Error('No Session UI probe is running.')
    state.stop()
    const { stop, ...data } = state
    void stop
    Reflect.deleteProperty(window, key)
    return { ...data, endedAt: performance.now() }
  }, PROBE_KEY)
  const gaps = raw.frameGaps.map(({ duration }) => duration).sort((a, b) => a - b)
  return {
    ...raw,
    durationMs: raw.endedAt - raw.startedAt,
    frameGapSummary: {
      count: gaps.length,
      medianMs: gaps.length
        ? (gaps[Math.floor((gaps.length - 1) / 2)] + gaps[Math.floor(gaps.length / 2)]) / 2
        : null,
      p95Ms: gaps.length ? gaps[Math.ceil(gaps.length * 0.95) - 1] : null,
      maxMs: gaps.at(-1) ?? null,
      over50Ms: gaps.filter((gap) => gap > 50).length,
      over100Ms: gaps.filter((gap) => gap > 100).length
    },
    longTaskSummary: {
      count: raw.longTasks.length,
      totalMs: raw.longTasks.reduce((sum, item) => sum + item.duration, 0),
      over50BlockingMs: raw.longTasks.reduce(
        (sum, item) => sum + Math.max(0, item.duration - 50),
        0
      )
    }
  }
}

export type SessionUiOpenTiming = {
  timeOrigin: number
  pointerDownAt: number
  clickAt: number
  clickEventAt: number
  contentVisibleAt: number
  presentationOpportunityAt: number
  clickToContentMs: number
  clickToPresentationOpportunityMs: number
  dispatchDelayMs: number
  handlerToPresentationOpportunityMs: number
  pointerDownToContentMs: number
  pointerDownToPresentationOpportunityMs: number
  trustedClick: boolean
}

export const measureClickToVisible = async (
  page: Page,
  trigger: Locator,
  target: { selector: string; text?: string; timeoutMs?: number }
): Promise<SessionUiOpenTiming> => {
  await assertSessionUiForeground(page)
  await trigger.evaluate(
    (element, { key, target }) => {
      const state = { result: undefined as SessionUiOpenTiming | undefined, error: '' }
      Reflect.set(window, key, state)
      let pointerDownAt: number | undefined
      element.addEventListener(
        'pointerdown',
        (event) => {
          pointerDownAt = event.timeStamp
        },
        { once: true, capture: true }
      )
      const visibleContent = (): Element | undefined => {
        for (const content of document.querySelectorAll(target.selector)) {
          if (target.text && !content.textContent?.includes(target.text)) continue
          if (
            !content.checkVisibility({
              contentVisibilityAuto: true,
              opacityProperty: true,
              visibilityProperty: true
            })
          )
            continue
          const rect = content.getBoundingClientRect()
          let left = Math.max(rect.left, 0)
          let right = Math.min(rect.right, innerWidth)
          let top = Math.max(rect.top, 0)
          let bottom = Math.min(rect.bottom, innerHeight)
          for (let parent = content.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent)
            const parentRect = parent.getBoundingClientRect()
            if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
              left = Math.max(left, parentRect.left + parent.clientLeft)
              right = Math.min(right, parentRect.left + parent.clientLeft + parent.clientWidth)
            }
            if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
              top = Math.max(top, parentRect.top + parent.clientTop)
              bottom = Math.min(bottom, parentRect.top + parent.clientTop + parent.clientHeight)
            }
          }
          if (right <= left || bottom <= top) continue
          // A dialog or other opaque surface must not count as conversation content being visible.
          const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
          if (hit && (hit === content || content.contains(hit))) return content
        }
        return undefined
      }
      element.addEventListener(
        'click',
        (event) => {
          const clickAt = performance.now()
          if (pointerDownAt === undefined) {
            state.error = 'Expected an actual pointer click for the open measurement.'
            return
          }
          const pointerStartedAt = pointerDownAt
          const deadline = clickAt + (target.timeoutMs ?? 30_000)
          const observe = (): void => {
            if (document.visibilityState !== 'visible' || !document.hasFocus()) {
              state.error = 'Window lost foreground while opening the conversation.'
              return
            }
            if (visibleContent()) {
              const contentVisibleAt = performance.now()
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  if (document.visibilityState !== 'visible' || !document.hasFocus()) {
                    state.error = 'Window lost foreground before the presentation opportunity.'
                    return
                  }
                  if (!visibleContent()) {
                    observe()
                    return
                  }
                  const presentationOpportunityAt = performance.now()
                  state.result = {
                    timeOrigin: performance.timeOrigin,
                    pointerDownAt: pointerStartedAt,
                    clickAt,
                    clickEventAt: event.timeStamp,
                    contentVisibleAt,
                    presentationOpportunityAt,
                    clickToContentMs: contentVisibleAt - event.timeStamp,
                    clickToPresentationOpportunityMs: presentationOpportunityAt - event.timeStamp,
                    dispatchDelayMs: clickAt - event.timeStamp,
                    handlerToPresentationOpportunityMs: presentationOpportunityAt - clickAt,
                    pointerDownToContentMs: contentVisibleAt - pointerStartedAt,
                    pointerDownToPresentationOpportunityMs:
                      presentationOpportunityAt - pointerStartedAt,
                    trustedClick: event.isTrusted
                  }
                })
              )
            } else if (performance.now() >= deadline)
              state.error = 'Visible conversation content timed out.'
            else requestAnimationFrame(observe)
          }
          requestAnimationFrame(observe)
        },
        { once: true, capture: true }
      )
    },
    { key: ACTION_KEY, target }
  )
  await trigger.click()
  await page.waitForFunction(
    (key) => {
      const state = Reflect.get(window, key)
      return Boolean(state?.result || state?.error)
    },
    ACTION_KEY,
    { timeout: (target.timeoutMs ?? 30_000) + 5_000, polling: 100 }
  )
  return page.evaluate((key) => {
    const state = Reflect.get(window, key)
    Reflect.deleteProperty(window, key)
    if (state.error) throw new Error(state.error)
    return state.result as SessionUiOpenTiming
  }, ACTION_KEY)
}

export type SessionUiInputTiming = {
  timeOrigin: number
  key: string
  keyEventAt: number
  keyHandlerAt: number
  inputAt: number
  presentationOpportunityAt: number
  dispatchDelayMs: number
  keyToPresentationOpportunityMs: number
  trusted: boolean
  domValueObserved: boolean
}

export const measureInputPresentation = async (
  page: Page,
  textbox: Locator,
  text: string,
  options: { delayMs?: number } = {}
): Promise<SessionUiInputTiming[]> => {
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error('Input probe requires printable ASCII.')
  await assertSessionUiForeground(page)
  await textbox.focus()
  await textbox.evaluate((element, key) => {
    const samples: SessionUiInputTiming[] = []
    let pending: { key: string; eventAt: number; handlerAt: number; trusted: boolean } | undefined
    let inFlight = 0
    let error = ''
    const value = (): string =>
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : (element.textContent ?? '')
    const keydown = (event: Event): void => {
      const keyboard = event as KeyboardEvent
      if (keyboard.key.length !== 1) return
      pending = {
        key: keyboard.key,
        eventAt: event.timeStamp,
        handlerAt: performance.now(),
        trusted: event.isTrusted
      }
    }
    const input = (event: Event): void => {
      if (!pending) return
      const current = pending
      pending = undefined
      const inputAt = performance.now()
      const inputValue = value()
      inFlight++
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const presentationOpportunityAt = performance.now()
          const domValueObserved =
            element.isConnected && inputValue.length > 0 && value().includes(inputValue)
          if (!domValueObserved) error = 'The typed value did not remain in the editor DOM.'
          if (document.visibilityState !== 'visible' || !document.hasFocus())
            error = 'Window lost foreground while measuring input.'
          samples.push({
            timeOrigin: performance.timeOrigin,
            key: current.key,
            keyEventAt: current.eventAt,
            keyHandlerAt: current.handlerAt,
            inputAt,
            presentationOpportunityAt,
            dispatchDelayMs: current.handlerAt - current.eventAt,
            keyToPresentationOpportunityMs: presentationOpportunityAt - current.eventAt,
            trusted: current.trusted && event.isTrusted,
            domValueObserved
          })
          inFlight--
        })
      )
    }
    element.addEventListener('keydown', keydown, true)
    element.addEventListener('input', input)
    Reflect.set(window, key, {
      samples,
      get inFlight() {
        return inFlight
      },
      get error() {
        return error
      },
      stop() {
        element.removeEventListener('keydown', keydown, true)
        element.removeEventListener('input', input)
      }
    })
  }, ACTION_KEY)
  try {
    await textbox.pressSequentially(text, { delay: options.delayMs ?? 120 })
    await page.waitForFunction(
      ({ key, count }) => {
        const state = Reflect.get(window, key)
        return state.error || (state.samples.length === count && state.inFlight === 0)
      },
      { key: ACTION_KEY, count: text.length },
      { timeout: 10_000, polling: 100 }
    )
    await assertSessionUiForeground(page)
    return await page.evaluate((key) => {
      const state = Reflect.get(window, key)
      if (state.error) throw new Error(state.error)
      return state.samples
    }, ACTION_KEY)
  } finally {
    await page.evaluate((key) => {
      Reflect.get(window, key)?.stop()
      Reflect.deleteProperty(window, key)
    }, ACTION_KEY)
  }
}

export type SessionFileWatchResult = {
  directory: string
  sessionId: string
  timeOrigin: number
  startedAt: number
  endedAt: number
  events: Array<{
    receivedAt: number
    eventType: string
    filename: string | null
    kind: 'primary' | 'temporary' | 'unknown'
  }>
  errors: string[]
}

// This is independent of the renderer IPC route, so it observes both renderer-initiated writes
// and RuntimeSessionOwner automatic saves. fs.watch can coalesce/duplicate notifications: its
// event count is NOT a save count, a durability receipt, bytes written, or a save duration.
export const startSessionFileWatch = (options: {
  directory: string
  sessionId: string
}): { stop(): Promise<SessionFileWatchResult> } => {
  const startedAt = performance.now()
  const events: SessionFileWatchResult['events'] = []
  const errors: string[] = []
  const primaryNames = [`${options.sessionId}.json`, `${options.sessionId}.jsonl`]
  const watcher = watch(options.directory, { persistent: false }, (eventType, name) => {
    const filename = name?.toString() ?? null
    const primary = filename !== null && primaryNames.includes(filename)
    const temporary =
      filename !== null &&
      primaryNames.some((base) => filename.startsWith(`${base}.`) && filename.endsWith('.tmp'))
    if (filename !== null && !primary && !temporary) return
    events.push({
      receivedAt: performance.now(),
      eventType,
      filename,
      kind: primary ? 'primary' : temporary ? 'temporary' : 'unknown'
    })
  })
  watcher.on('error', (error) => errors.push(error.message))
  let closed = false
  watcher.on('close', () => {
    closed = true
  })
  let stopped: Promise<SessionFileWatchResult> | undefined
  return {
    stop() {
      stopped ??= new Promise<SessionFileWatchResult>((resolve) => {
        const endedAt = performance.now()
        const finish = (): void => {
          resolve({
            ...options,
            timeOrigin: performance.timeOrigin,
            startedAt,
            endedAt,
            events,
            errors
          })
        }
        if (closed) finish()
        else {
          watcher.once('close', finish)
          watcher.close()
        }
      })
      return stopped
    }
  }
}
