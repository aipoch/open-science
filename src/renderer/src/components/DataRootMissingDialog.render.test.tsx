// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../shared/web-caller-location'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
import { DataRootMissingDialog } from './DataRootMissingDialog'

let container: HTMLDivElement
let root: Root

type MockStorageApi = {
  acceptMissingDataRoot: ReturnType<typeof vi.fn>
  getInfo: ReturnType<typeof vi.fn>
  pickDirectory: ReturnType<typeof vi.fn>
  inspectDataRoot: ReturnType<typeof vi.fn>
  setDataRootAndRelaunch: ReturnType<typeof vi.fn>
}

const installApi = (overrides: Partial<MockStorageApi> = {}): MockStorageApi => {
  const api: MockStorageApi = {
    acceptMissingDataRoot: vi.fn().mockResolvedValue(undefined),
    getInfo: vi.fn().mockResolvedValue({ dataRootMissing: true }),
    pickDirectory: vi.fn().mockResolvedValue(null),
    inspectDataRoot: vi.fn(),
    setDataRootAndRelaunch: vi.fn(),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = { storage: api }
  return api
}

// AlertDialog content renders via a Portal into document.body, outside `container`.
const clickButton = (matcher: RegExp): void => {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => matcher.test(candidate.textContent ?? '')
  )
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
  document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
  document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
  delete (window as unknown as { api?: unknown }).api
})

describe('DataRootMissingDialog', () => {
  it('offers only remote-safe retry when the host data root is missing in Web', async () => {
    installApi()
    document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'remote')

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toContain('Reconnect & retry')
    expect(document.body.textContent).toContain(
      'To choose another location or continue with an empty folder, use Open Science on the home computer.'
    )
    expect(document.body.textContent).not.toContain('Choose another location')
    expect(document.body.textContent).not.toContain('Continue with an empty folder')
  })

  it('offers local recovery actions when the host data root is missing in local Web', async () => {
    installApi()
    document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'local')

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons).toHaveLength(3)
    expect(document.body.textContent).toContain('Choose another location')
    expect(document.body.textContent).toContain('Continue with an empty folder')
  })

  it('uses shared settings dialog chrome for the missing data root guard', async () => {
    installApi()

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

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
    expect(dialog?.className).toContain('data-[state=closed]:fill-mode-forwards')
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
  })

  it('renders the folder-not-found copy with the configured path when open', async () => {
    installApi()

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    expect(document.body.textContent).toContain('Your data folder')
    expect(document.body.textContent).toContain('/mnt/drive/OpenScience')
    expect(document.body.textContent).toContain(
      "It may have been deleted, or it's on a drive that isn't connected."
    )
  })

  it('does not render dialog content when closed', async () => {
    installApi()

    await act(async () => {
      root.render(
        <DataRootMissingDialog
          open={false}
          dataRoot="/mnt/drive/OpenScience"
          onResolved={vi.fn()}
        />
      )
    })

    expect(document.body.textContent).not.toContain('Data folder not found')
  })

  it('Reconnect & retry closes the dialog once getInfo reports the drive is back', async () => {
    const api = installApi({ getInfo: vi.fn().mockResolvedValue({ dataRootMissing: false }) })
    const onResolved = vi.fn()

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={onResolved} />
      )
    })

    await act(async () => {
      clickButton(/reconnect/i)
      await Promise.resolve()
    })

    expect(api.getInfo).toHaveBeenCalledTimes(1)
    expect(onResolved).toHaveBeenCalledTimes(1)
  })

  it('Reconnect & retry shows a still-not-found note when the drive is still missing', async () => {
    const api = installApi({ getInfo: vi.fn().mockResolvedValue({ dataRootMissing: true }) })
    const onResolved = vi.fn()

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={onResolved} />
      )
    })

    await act(async () => {
      clickButton(/reconnect/i)
      await Promise.resolve()
    })

    expect(api.getInfo).toHaveBeenCalledTimes(1)
    expect(onResolved).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Still not found')
  })

  it('Reconnect & retry re-enables every action when getInfo rejects', async () => {
    installApi({ getInfo: vi.fn().mockRejectedValue(new Error('IPC unavailable')) })

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    await act(async () => {
      clickButton(/reconnect/i)
      await Promise.resolve()
    })

    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons).toHaveLength(3)
    expect(buttons.every((button) => !button.disabled)).toBe(true)
    expect(document.body.textContent).toContain('Could not check the data folder. Try again.')
  })

  it('Choose another location adopts an existing data folder and relaunches', async () => {
    const api = installApi({
      pickDirectory: vi.fn().mockResolvedValue('/mnt/other'),
      inspectDataRoot: vi
        .fn()
        .mockResolvedValue({ kind: 'adopt', dataRoot: '/mnt/other/OpenScience' }),
      setDataRootAndRelaunch: vi.fn().mockResolvedValue({ ok: true })
    })

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    await act(async () => {
      clickButton(/choose another location/i)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.pickDirectory).toHaveBeenCalledTimes(1)
    expect(api.inspectDataRoot).toHaveBeenCalledWith('/mnt/other')
    expect(api.setDataRootAndRelaunch).toHaveBeenCalledWith('/mnt/other', false)
    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons).toHaveLength(3)
    expect(buttons.every((button) => button.disabled)).toBe(true)
  })

  it('Choose another location on an empty (move) target also applies via setDataRootAndRelaunch', async () => {
    const api = installApi({
      pickDirectory: vi.fn().mockResolvedValue('/mnt/empty'),
      inspectDataRoot: vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/empty/OpenScience' }),
      setDataRootAndRelaunch: vi.fn().mockResolvedValue({ ok: true })
    })

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    await act(async () => {
      clickButton(/choose another location/i)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.setDataRootAndRelaunch).toHaveBeenCalledWith('/mnt/empty', false)
  })

  it('Choose another location shows an inline error for an invalid target and does not relaunch', async () => {
    const api = installApi({
      pickDirectory: vi.fn().mockResolvedValue('/mnt/bad'),
      inspectDataRoot: vi.fn().mockResolvedValue({
        kind: 'invalid',
        dataRoot: '/mnt/bad/OpenScience',
        error: 'The selected folder is not writable.'
      }),
      setDataRootAndRelaunch: vi.fn()
    })

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    await act(async () => {
      clickButton(/choose another location/i)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('The selected folder is not writable.')
    expect(api.setDataRootAndRelaunch).not.toHaveBeenCalled()
  })

  it('Choose another location re-enables every action when folder inspection rejects', async () => {
    installApi({
      pickDirectory: vi.fn().mockResolvedValue('/mnt/other'),
      inspectDataRoot: vi.fn().mockRejectedValue(new Error('IPC unavailable'))
    })

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    await act(async () => {
      clickButton(/choose another location/i)
      await Promise.resolve()
      await Promise.resolve()
    })

    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons).toHaveLength(3)
    expect(buttons.every((button) => !button.disabled)).toBe(true)
    expect(document.body.textContent).toContain('Could not switch to this folder.')
  })

  it('Choose another location stays recoverable when the directory picker rejects', async () => {
    installApi({ pickDirectory: vi.fn().mockRejectedValue(new Error('IPC unavailable')) })

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    await act(async () => {
      clickButton(/choose another location/i)
      await Promise.resolve()
    })

    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons).toHaveLength(3)
    expect(buttons.every((button) => !button.disabled)).toBe(true)
    expect(document.body.textContent).toContain('Could not switch to this folder.')
  })

  it('Choose another location re-enables every action when applying the folder rejects', async () => {
    const api = installApi({
      pickDirectory: vi.fn().mockResolvedValue('/mnt/other'),
      inspectDataRoot: vi
        .fn()
        .mockResolvedValue({ kind: 'adopt', dataRoot: '/mnt/other/OpenScience' }),
      setDataRootAndRelaunch: vi.fn().mockRejectedValue(new Error('IPC unavailable'))
    })

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    await act(async () => {
      clickButton(/choose another location/i)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(api.setDataRootAndRelaunch).toHaveBeenCalledWith('/mnt/other', false)
    expect(buttons).toHaveLength(3)
    expect(buttons.every((button) => !button.disabled)).toBe(true)
    expect(document.body.textContent).toContain('Could not switch to this folder.')
  })

  it('Choose another location cancelled (null pick) does nothing', async () => {
    const api = installApi({ pickDirectory: vi.fn().mockResolvedValue(null) })

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={vi.fn()} />
      )
    })

    await act(async () => {
      clickButton(/choose another location/i)
      await Promise.resolve()
    })

    expect(api.inspectDataRoot).not.toHaveBeenCalled()
  })

  it('Continue with an empty folder waits for main-process acceptance before dismissing', async () => {
    const api = installApi()
    const onResolved = vi.fn()

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={onResolved} />
      )
    })

    await act(async () => {
      clickButton(/continue with an empty folder/i)
      await Promise.resolve()
    })

    expect(api.acceptMissingDataRoot).toHaveBeenCalledTimes(1)
    expect(onResolved).toHaveBeenCalledTimes(1)
    expect(api.pickDirectory).not.toHaveBeenCalled()
    expect(api.getInfo).not.toHaveBeenCalled()
  })

  it('continues through the legacy resolution path when an older local Main has no acceptance RPC', async () => {
    const api = installApi()
    Reflect.deleteProperty(api, 'acceptMissingDataRoot')
    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'local')
    const onResolved = vi.fn()

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={onResolved} />
      )
    })

    await act(async () => {
      clickButton(/continue with an empty folder/i)
      await Promise.resolve()
    })

    expect(onResolved).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain(
      'Could not continue with an empty folder. Try again.'
    )
  })

  it('Continue with an empty folder keeps the dialog recoverable when acceptance fails', async () => {
    const api = installApi({
      acceptMissingDataRoot: vi.fn().mockRejectedValue(new Error('IPC unavailable'))
    })
    const onResolved = vi.fn()

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={onResolved} />
      )
    })

    await act(async () => {
      clickButton(/continue with an empty folder/i)
      await Promise.resolve()
    })

    expect(api.acceptMissingDataRoot).toHaveBeenCalledTimes(1)
    expect(onResolved).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(
      'Could not continue with an empty folder. Try again.'
    )
    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons.every((button) => !button.disabled)).toBe(true)
  })
})
