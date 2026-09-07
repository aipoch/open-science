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
  cancelMigrate: ReturnType<typeof vi.fn>
  commitAndRelaunch: ReturnType<typeof vi.fn>
  discardMigratedCopy: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
}

const installApi = (overrides: Partial<MockStorageApi> = {}): MockStorageApi => {
  const api: MockStorageApi = {
    pickDirectory: vi.fn().mockResolvedValue(null),
    // Default: resolving the move destination (from defaultParent) yields the visible OpenScience path.
    inspectDataRoot: vi.fn().mockResolvedValue({ kind: 'move', dataRoot: '/home/u/OpenScience' }),
    dismissLegacyMovePrompt: vi.fn().mockResolvedValue(undefined),
    detectActive: vi.fn().mockResolvedValue([]),
    migrate: vi.fn().mockResolvedValue({ ok: true, cleanupPending: false }),
    cancelMigrate: vi.fn().mockResolvedValue(undefined),
    commitAndRelaunch: vi.fn().mockResolvedValue({ ok: true, cleanupPending: false }),
    discardMigratedCopy: vi.fn().mockResolvedValue({ ok: true }),
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
  it('keeps a covered legacy prompt pending without dismissing it', async () => {
    const api = installApi()

    await act(async () => {
      root.render(
        <LegacyDataMoveDialog
          active={false}
          currentDataRoot="/home/u/.open-science"
          defaultParent="/home/u"
          onDismiss={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(api.dismissLegacyMovePrompt).not.toHaveBeenCalled()
  })

  it('uses shared settings dialog chrome without changing the move choices', async () => {
    installApi()
    await renderDialog()

    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')

    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(overlay?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(overlay?.className).not.toContain('backdrop-blur')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.className).toContain('overflow-hidden')
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('border-b border-border-300/90 px-5 py-3.5')
      )
    ).toBe(true)
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('border-t border-border-300/90 px-5 py-3.5')
      )
    ).toBe(true)
    expect(document.body.textContent).toContain('Move to OpenScience')
    expect(document.body.textContent).toContain('Choose another folder')
    expect(document.body.textContent).toContain('Keep it in the current folder')
  })

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

  it('resumes a verified default move and refreshes the destination after discard', async () => {
    const api = installApi({
      inspectDataRoot: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'recover',
          recoveryStatus: 'verified',
          dataRoot: '/home/u/OpenScience'
        })
        .mockResolvedValue({ kind: 'move', dataRoot: '/home/u/OpenScience' })
    })
    await renderDialog()

    await act(async () => {
      clickButton(/Move to OpenScience/)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Verified data copy found')
    expect(api.migrate).not.toHaveBeenCalled()

    await act(async () => {
      clickButton(/Discard copy/)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toContain('Verified data copy found')
    expect(document.body.textContent).toContain('Move your data to a visible folder?')
    expect(api.inspectDataRoot).toHaveBeenCalledTimes(2)

    await act(async () => {
      clickButton(/Move to OpenScience/)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.migrate).toHaveBeenCalledWith('/home/u')
  })

  it('waits for default inspection before enabling the move action', async () => {
    let resolveInspection!: (result: {
      kind: 'recover'
      recoveryStatus: 'verified'
      dataRoot: string
    }) => void
    installApi({
      inspectDataRoot: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveInspection = resolve
        })
      )
    })
    await renderDialog()

    const moveButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Move to OpenScience'
    )
    expect(moveButton?.disabled).toBe(true)

    await act(async () => {
      resolveInspection({
        kind: 'recover',
        recoveryStatus: 'verified',
        dataRoot: '/home/u/OpenScience'
      })
      await Promise.resolve()
    })

    expect(moveButton?.disabled).toBe(false)
  })

  it('does not remain stuck resolving when the default destination inspection fails', async () => {
    const api = installApi({
      inspectDataRoot: vi
        .fn()
        .mockRejectedValueOnce(new Error('inspection unavailable'))
        .mockResolvedValueOnce({ kind: 'move', dataRoot: '/home/u/OpenScience' })
    })
    await renderDialog()

    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toContain('Resolving…')
    expect(document.body.textContent).toContain('Unavailable')
    expect(document.body.textContent).toContain('Could not check the data folder. Try again.')

    await act(async () => {
      clickButton(/^Try again$/)
      await Promise.resolve()
    })

    expect(api.inspectDataRoot).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('/home/u/OpenScience')
  })

  it('does not dismiss the prompt when persisting the keep-here choice fails', async () => {
    const api = installApi({
      dismissLegacyMovePrompt: vi
        .fn()
        .mockRejectedValueOnce(new Error('settings write failed'))
        .mockResolvedValueOnce(undefined)
    })
    const onDismiss = vi.fn()
    await renderDialog(onDismiss)

    await act(async () => {
      clickButton(/Keep it in the current/)
      await Promise.resolve()
    })

    expect(api.dismissLegacyMovePrompt).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Could not save changes.')

    await act(async () => {
      clickButton(/Keep it in the current/)
      await Promise.resolve()
    })

    expect(api.dismissLegacyMovePrompt).toHaveBeenCalledTimes(2)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('offers discard-only recovery for an interrupted chosen-folder copy', async () => {
    const api = installApi({
      pickDirectory: vi.fn().mockResolvedValue('/mnt/interrupted'),
      inspectDataRoot: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'move', dataRoot: '/home/u/OpenScience' })
        .mockResolvedValueOnce({
          kind: 'recover',
          recoveryStatus: 'copying',
          dataRoot: '/mnt/interrupted/OpenScience'
        })
    })
    await renderDialog()

    await act(async () => {
      clickButton(/Choose another folder/)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Incomplete data copy found')
    expect(document.body.textContent).toContain('Discard incomplete copy')
    expect(document.body.textContent).not.toContain('Finish move')
    expect(api.migrate).not.toHaveBeenCalled()
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

  it('reports a chosen-folder inspection failure and re-enables every action', async () => {
    installApi({
      pickDirectory: vi.fn().mockResolvedValue('/mnt/unavailable'),
      inspectDataRoot: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'move', dataRoot: '/home/u/OpenScience' })
        .mockRejectedValueOnce(new Error('inspection unavailable'))
    })
    await renderDialog()

    await act(async () => {
      clickButton(/Choose another folder/)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Could not check the data folder. Try again.')
    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons).toHaveLength(3)
    expect(buttons.every((button) => !button.disabled)).toBe(true)
  })
})
