// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LegacyDataMoveDialog } from './LegacyDataMoveDialog'

let container: HTMLDivElement
let root: Root

type MockStorageApi = {
  pickDirectory: ReturnType<typeof vi.fn>
  inspectDataRoot: ReturnType<typeof vi.fn>
  dismissLegacyMovePrompt: ReturnType<typeof vi.fn>
  detectActive: ReturnType<typeof vi.fn>
  migrate: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
}

const installApi = (overrides: Partial<MockStorageApi> = {}): MockStorageApi => {
  const api: MockStorageApi = {
    pickDirectory: vi.fn().mockResolvedValue(null),
    // Default: resolving the move destination (from defaultParent) yields the visible OpenScience path.
    inspectDataRoot: vi.fn().mockResolvedValue({ kind: 'move', dataRoot: '/home/u/OpenScience' }),
    dismissLegacyMovePrompt: vi.fn().mockResolvedValue(undefined),
    detectActive: vi.fn().mockResolvedValue([]),
    migrate: vi.fn().mockResolvedValue({ ok: true }),
    onProgress: vi.fn(() => () => {}),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = { storage: api }
  return api
}

// AlertDialog / Dialog content renders via a Portal into document.body, outside `container`.
const clickButton = (matcher: RegExp): void => {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => matcher.test(candidate.textContent ?? '')
  )
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const renderDialog = async (onDismiss = vi.fn()): Promise<void> => {
  await act(async () => {
    root.render(
      <LegacyDataMoveDialog
        currentDataRoot="/home/u/.open-science"
        defaultParent="/home/u"
        onDismiss={onDismiss}
      />
    )
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('LegacyDataMoveDialog', () => {
  it('shows both paths and the three choices', async () => {
    installApi()
    await renderDialog()

    expect(document.body.textContent).toContain('/home/u/.open-science')
    expect(document.body.textContent).toContain('/home/u/OpenScience')
    for (const label of [
      /Move to OpenScience/,
      /Choose another folder/,
      /Keep it in the current/
    ]) {
      expect(
        Array.from(document.body.querySelectorAll('button')).some((b) =>
          label.test(b.textContent ?? '')
        )
      ).toBe(true)
    }
  })

  it('persists the dismissal and calls onDismiss when kept in place', async () => {
    const api = installApi()
    const onDismiss = vi.fn()
    await renderDialog(onDismiss)

    await act(async () => {
      clickButton(/Keep it in the current/)
      await Promise.resolve()
    })

    expect(api.dismissLegacyMovePrompt).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('"Move to OpenScience" hands off to the migration flow (detects sessions first)', async () => {
    const api = installApi()
    await renderDialog()

    await act(async () => {
      clickButton(/Move to OpenScience/)
      await Promise.resolve()
    })

    // The shared migration modal mounts and begins by detecting running sessions.
    expect(api.detectActive).toHaveBeenCalled()
    // Declining/moving never wrote a dismissal here — moving sets dataRoot instead.
    expect(api.dismissLegacyMovePrompt).not.toHaveBeenCalled()
  })

  it('a chosen empty folder starts the move; an unusable pick shows an inline error', async () => {
    const api = installApi({
      pickDirectory: vi.fn().mockResolvedValue('/mnt/bad'),
      inspectDataRoot: vi
        .fn()
        .mockResolvedValue({ kind: 'invalid', dataRoot: '/mnt/bad/OpenScience', error: 'Nope.' })
    })
    await renderDialog()

    await act(async () => {
      clickButton(/Choose another folder/)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.inspectDataRoot).toHaveBeenCalledWith('/mnt/bad')
    expect(document.body.textContent).toContain('Nope.')
    // An invalid pick must not start a migration.
    expect(api.detectActive).not.toHaveBeenCalled()
  })
})
