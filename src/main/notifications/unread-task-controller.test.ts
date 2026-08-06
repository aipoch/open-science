import { describe, expect, it, vi } from 'vitest'

import {
  createUnreadTaskController,
  wireUnreadTaskController,
  type UnreadTaskBadge,
  type UnreadTaskController,
  type UnreadTaskRepository
} from './unread-task-controller'

type ControllerHarness = {
  controller: UnreadTaskController
  state: { focused: boolean }
  saves: string[][]
  badgeCounts: number[]
  errors: unknown[]
}

const createHarness = (
  overrides: {
    initial?: string[]
    focused?: boolean
    headless?: boolean
    isAppFocused?: () => boolean
    load?: () => Promise<string[]>
    save?: (sessionIds: string[]) => Promise<void>
    setBadgeCount?: (count: number) => void
    confirmSessionVisible?: (sessionId: string) => Promise<boolean>
  } = {}
): ControllerHarness => {
  const state = { focused: overrides.focused ?? false }
  const saves: string[][] = []
  const badgeCounts: number[] = []
  const errors: unknown[] = []
  const repository: UnreadTaskRepository = {
    load: overrides.load ?? (() => Promise.resolve(overrides.initial ?? [])),
    save:
      overrides.save ??
      ((sessionIds) => {
        saves.push([...sessionIds])
        return Promise.resolve()
      })
  }
  const badge: UnreadTaskBadge = {
    setCount:
      overrides.setBadgeCount ??
      ((count) => {
        badgeCounts.push(count)
      })
  }
  const controller = createUnreadTaskController({
    headless: overrides.headless ?? false,
    isAppFocused: overrides.isAppFocused ?? (() => state.focused),
    repository,
    badge,
    confirmSessionVisible: overrides.confirmSessionVisible,
    onError: (error) => errors.push(error)
  })

  return { controller, state, saves, badgeCounts, errors }
}

describe('createUnreadTaskController', () => {
  it('restores persisted unread sessions and reapplies the native badge', async () => {
    const { controller, badgeCounts } = createHarness({ initial: ['session-1', 'session-2'] })

    await controller.restore()

    expect(badgeCounts).toEqual([2])
  })

  it('counts each completed session at most once', async () => {
    const { controller, saves, badgeCounts } = createHarness()
    await controller.restore()

    await controller.markUnread('session-1')
    await controller.markUnread('session-1')

    expect(saves).toEqual([['session-1']])
    expect(badgeCounts.at(-1)).toBe(1)
  })

  it('does not mark the focused, currently visible session as unread', async () => {
    const confirmSessionVisible = vi.fn(async (sessionId: string) => sessionId === 'session-1')
    const { controller, state, saves } = createHarness({ focused: true, confirmSessionVisible })
    await controller.restore()
    await controller.syncViewState({
      visibleSessionId: 'session-1'
    })

    await controller.markUnread('session-1')
    await controller.markUnread('session-2')

    expect(state.focused).toBe(true)
    expect(confirmSessionVisible).toHaveBeenCalledWith('session-1')
    expect(saves).toEqual([['session-2']])
  })

  it('marks a background session unread even when it is selected underneath', async () => {
    const { controller, state, saves } = createHarness({ focused: false })
    await controller.restore()
    await controller.syncViewState({ visibleSessionId: 'session-1' })

    await controller.markUnread('session-1')

    expect(state.focused).toBe(false)
    expect(saves).toEqual([['session-1']])
  })

  it('uses a fresh renderer visibility challenge instead of a stale visible projection', async () => {
    const confirmSessionVisible = vi.fn(async () => false)
    const { controller, saves } = createHarness({ focused: true, confirmSessionVisible })
    await controller.restore()
    await controller.syncViewState({ visibleSessionId: 'session-1' })

    await controller.markUnread('session-1')

    expect(confirmSessionVisible).toHaveBeenCalledWith('session-1')
    expect(saves).toEqual([['session-1']])
  })

  it('records unread and reports a renderer visibility challenge failure', async () => {
    const error = new Error('renderer unavailable')
    const { controller, errors, saves, badgeCounts } = createHarness({
      focused: true,
      confirmSessionVisible: () => Promise.reject(error)
    })

    await controller.markUnread('session-1')

    expect(badgeCounts.at(-1)).toBe(1)
    expect(saves).toEqual([])
    expect(errors).toEqual([error])
  })

  it('records unread when the app loses focus while a visibility challenge is pending', async () => {
    let resolveVisibility: ((visible: boolean) => void) | undefined
    const visibility = new Promise<boolean>((resolve) => {
      resolveVisibility = resolve
    })
    const { controller, state, saves, badgeCounts } = createHarness({
      focused: true,
      confirmSessionVisible: () => visibility
    })

    const marking = controller.markUnread('session-1')
    state.focused = false
    resolveVisibility?.(true)
    await marking

    expect(badgeCounts.at(-1)).toBe(1)
    expect(saves).toEqual([])
  })

  it('clears only the focused visible session', async () => {
    const { controller, state, saves } = createHarness({
      initial: ['session-1', 'session-2'],
      focused: false
    })
    await controller.restore()

    await controller.syncViewState({ visibleSessionId: 'session-1' })

    state.focused = true
    await controller.handleAppFocus()

    expect(saves).toEqual([['session-2']])
  })

  it('keeps unread when a fresh focus challenge reports the cached session is hidden', async () => {
    const confirmSessionVisible = vi.fn(async () => false)
    const { controller, state, saves, badgeCounts } = createHarness({
      initial: ['session-1'],
      focused: false,
      confirmSessionVisible
    })
    await controller.restore()
    await controller.syncViewState({ visibleSessionId: 'session-1' })

    state.focused = true
    await controller.handleAppFocus()

    expect(confirmSessionVisible).toHaveBeenCalledWith('session-1')
    expect(saves).toEqual([])
    expect(badgeCounts.at(-1)).toBe(1)
  })

  it('keeps unread when the app loses focus during the focus visibility challenge', async () => {
    let resolveVisibility: ((visible: boolean) => void) | undefined
    const visibility = new Promise<boolean>((resolve) => {
      resolveVisibility = resolve
    })
    const { controller, state, saves } = createHarness({
      initial: ['session-1'],
      focused: false,
      confirmSessionVisible: () => visibility
    })
    await controller.restore()
    await controller.syncViewState({ visibleSessionId: 'session-1' })

    state.focused = true
    const focusing = controller.handleAppFocus()
    state.focused = false
    resolveVisibility?.(true)
    await focusing

    expect(saves).toEqual([])
  })

  it('clears a focused visible session without touching other unread sessions', async () => {
    const { controller, saves } = createHarness({
      initial: ['session-1', 'not-loaded-session'],
      focused: true
    })
    await controller.restore()

    await controller.syncViewState({ visibleSessionId: 'session-1' })

    expect(saves).toEqual([['not-loaded-session']])
  })

  it('reapplies the badge on an unchanged renderer sync for a recreated Windows window', async () => {
    const { controller, badgeCounts } = createHarness({ initial: ['session-1'] })
    await controller.restore()

    await controller.syncViewState({})

    expect(badgeCounts).toEqual([1, 1])
  })

  it('invalidates the visible projection when the main window is recreated', async () => {
    const { controller, state, saves } = createHarness({
      initial: ['session-1'],
      focused: false
    })
    await controller.restore()
    await controller.syncViewState({ visibleSessionId: 'session-1' })

    ;(
      controller as UnreadTaskController & { handleWindowCreated: () => void }
    ).handleWindowCreated()
    state.focused = true
    await controller.handleAppFocus()

    expect(saves).toEqual([])
  })

  it('removes an unread session after its durable session deletion succeeds', async () => {
    const { controller, saves, badgeCounts } = createHarness({
      initial: ['session-1', 'session-2']
    })
    await controller.restore()

    await controller.removeUnreadSessions(['session-1'])

    expect(saves).toEqual([['session-2']])
    expect(badgeCounts.at(-1)).toBe(1)
  })

  it('removes a deleted project session batch with one badge refresh and persistence write', async () => {
    const { controller, saves, badgeCounts } = createHarness({
      initial: ['session-1', 'session-2', 'session-3']
    })
    await controller.restore()
    badgeCounts.length = 0

    await controller.removeUnreadSessions(['session-1', 'session-2'])

    expect(saves).toEqual([['session-3']])
    expect(badgeCounts).toEqual([1])
  })

  it('retains every project deletion tombstone beyond the unread-state capacity', async () => {
    const { controller, saves } = createHarness()
    const deletedSessionIds = Array.from({ length: 1_001 }, (_, index) => `deleted-${index}`)

    await controller.removeUnreadSessions(deletedSessionIds)
    await controller.markUnread('deleted-0')

    expect(saves).toEqual([])
  })

  it('does not resurrect unread state when deletion wins a pending visibility challenge', async () => {
    let resolveVisibility: ((visible: boolean) => void) | undefined
    const visibility = new Promise<boolean>((resolve) => {
      resolveVisibility = resolve
    })
    const { controller, saves } = createHarness({
      focused: true,
      confirmSessionVisible: () => visibility
    })

    const marking = controller.markUnread('session-1')
    await controller.removeUnreadSessions(['session-1'])
    resolveVisibility?.(false)
    await marking

    expect(saves).toEqual([])
  })

  it('does not load, persist, or render unread state in headless mode', async () => {
    const load = vi.fn(async () => ['session-1'])
    const save = vi.fn(async () => undefined)
    const { controller, badgeCounts } = createHarness({ headless: true, load, save })

    await controller.restore()
    await controller.markUnread('session-2')
    await controller.syncViewState({})

    expect(load).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(badgeCounts).toEqual([])
  })

  it('treats a destroyed-window focus error as unfocused and still records unread', async () => {
    const error = new Error('Object has been destroyed')
    const { controller, saves, badgeCounts, errors } = createHarness({
      isAppFocused: () => {
        throw error
      }
    })
    await controller.restore()
    badgeCounts.length = 0

    await controller.markUnread('session-1')

    expect(saves).toEqual([['session-1']])
    expect(badgeCounts).toEqual([1])
    expect(errors).toContain(error)
  })

  it('keeps in-memory state without overwriting persistence after restore fails', async () => {
    const readError = new Error('read failed')
    const badgeError = new Error('badge failed')
    const { controller, saves, errors } = createHarness({
      load: () => Promise.reject(readError),
      setBadgeCount: () => {
        throw badgeError
      }
    })

    await expect(controller.restore()).resolves.toBeUndefined()
    await expect(controller.markUnread('session-1')).resolves.toBeUndefined()

    expect(saves).toEqual([])
    expect(errors).toEqual([readError, badgeError, badgeError])
  })
})

describe('wireUnreadTaskController', () => {
  it('binds terminal unread recording and refreshes/clears on app window events', async () => {
    const listeners = new Map<string, () => void>()
    const controller = {
      restore: vi.fn(async () => undefined),
      markUnread: vi.fn(async () => undefined),
      markReadSessions: vi.fn(async () => undefined),
      removeUnreadSessions: vi.fn(async () => undefined),
      syncViewState: vi.fn(async () => undefined),
      handleAppFocus: vi.fn(async () => undefined),
      handleWindowCreated: vi.fn(),
      refreshBadge: vi.fn()
    }
    const setUnreadHandler = vi.fn()

    wireUnreadTaskController({
      app: {
        on: (event, listener) => {
          listeners.set(event, listener)
        }
      },
      taskNotifications: { setUnreadHandler },
      controller
    })

    expect(setUnreadHandler).toHaveBeenCalledWith(controller.markUnread)

    listeners.get('browser-window-focus')?.()
    listeners.get('browser-window-created')?.()
    await Promise.resolve()

    expect(controller.handleAppFocus).toHaveBeenCalledTimes(1)
    expect(controller.handleWindowCreated).toHaveBeenCalledTimes(1)
  })
})
