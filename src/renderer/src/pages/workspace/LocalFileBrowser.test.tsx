// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LocalDirListing } from '../../../../shared/local-fs'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { LocalFileBrowser } from './LocalFileBrowser'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOME = '/Users/roxi'
const GRANTED = `${HOME}/data`

let container: HTMLElement
let root: Root
let listDir: ReturnType<typeof vi.fn>

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  listDir = vi.fn(async (path: string): Promise<LocalDirListing> => ({
    entries: [],
    truncated: false,
    resolvedPath: path
  }))
  ;(window as unknown as { api: unknown }).api = {
    localFs: {
      getRoots: vi.fn().mockResolvedValue({ home: HOME, machineName: 'Test Mac' }),
      listDir
    },
    compute: {
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined)
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const addressInput = (): HTMLInputElement | null =>
  document.body.querySelector<HTMLInputElement>('[aria-label="Directory path"]')

describe('LocalFileBrowser requestedPath', () => {
  it('lands in Home without a requested path', async () => {
    await act(async () => {
      root.render(<LocalFileBrowser />)
    })
    await flush()

    expect(listDir).toHaveBeenCalledWith(HOME)
    expect(addressInput()?.value).toBe(HOME)
  })

  it('navigates when the requested path nonce changes', async () => {
    await act(async () => {
      root.render(<LocalFileBrowser />)
    })
    await flush()
    expect(addressInput()?.value).toBe(HOME)

    await act(async () => {
      root.render(<LocalFileBrowser requestedPath={{ path: GRANTED, nonce: 1 }} />)
    })
    await flush()

    expect(listDir).toHaveBeenCalledWith(GRANTED)
    expect(addressInput()?.value).toBe(GRANTED)
  })

  it('does not re-navigate for a nonce it already handled', async () => {
    await act(async () => {
      root.render(<LocalFileBrowser requestedPath={{ path: GRANTED, nonce: 1 }} />)
    })
    await flush()
    expect(listDir).toHaveBeenCalledTimes(1)

    // Re-render with the same request: no additional listing call.
    await act(async () => {
      root.render(<LocalFileBrowser requestedPath={{ path: GRANTED, nonce: 1 }} />)
    })
    await flush()
    expect(listDir).toHaveBeenCalledTimes(1)
  })

  it('uses a request pending at mount as the initial location instead of Home', async () => {
    await act(async () => {
      root.render(<LocalFileBrowser requestedPath={{ path: GRANTED, nonce: 1 }} />)
    })
    await flush()

    expect(listDir).toHaveBeenCalledTimes(1)
    expect(listDir).toHaveBeenCalledWith(GRANTED)
    expect(listDir).not.toHaveBeenCalledWith(HOME)
    expect(addressInput()?.value).toBe(GRANTED)
  })
})
