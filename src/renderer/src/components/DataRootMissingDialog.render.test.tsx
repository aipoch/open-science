// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataRootMissingDialog } from './DataRootMissingDialog'

let container: HTMLDivElement
let root: Root

type MockStorageApi = {
  getInfo: ReturnType<typeof vi.fn>
  pickDirectory: ReturnType<typeof vi.fn>
  inspectDataRoot: ReturnType<typeof vi.fn>
  setDataRootAndRelaunch: ReturnType<typeof vi.fn>
}

const installApi = (overrides: Partial<MockStorageApi> = {}): MockStorageApi => {
  const api: MockStorageApi = {
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('DataRootMissingDialog', () => {
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

  it('Continue with an empty folder dismisses without any IPC call', async () => {
    const api = installApi()
    const onResolved = vi.fn()

    await act(async () => {
      root.render(
        <DataRootMissingDialog open dataRoot="/mnt/drive/OpenScience" onResolved={onResolved} />
      )
    })

    clickButton(/continue with an empty folder/i)

    expect(onResolved).toHaveBeenCalledTimes(1)
    expect(api.pickDirectory).not.toHaveBeenCalled()
    expect(api.getInfo).not.toHaveBeenCalled()
  })
})
