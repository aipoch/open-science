// @vitest-environment jsdom
// Locale coverage for FileBrowserModal: chrome, listing columns, error banner, detail panel and
// the download success banner must all follow the active language — including text that was
// produced by an earlier event and is only rendered later (see the language-switch cases).
import { openRadixMenu } from './test-utils'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../../../shared/compute'
import type { DirListing, LocalFile } from '../../../../shared/remote-fs'
import { FileBrowserModal } from './FileBrowserModal'
import { i18next } from '@/i18n'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'

let container: HTMLDivElement
let root: Root

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

const connectedHost = (): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: '/scratch/user',
  scratchPinned: true,
  concurrencyLimit: undefined,
  probeResult: {
    ok: true,
    probedAt: new Date().toISOString(),
    exitCode: 0,
    errorTail: null,
    cpus: 4
  },
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1
})

// mtime one minute in the past so the Modified column lands in the "minute" age bucket.
const mockListing = (overrides: Partial<DirListing> = {}): DirListing => ({
  entries: [
    { name: 'data', isDirectory: true, size: 0, mtimeMs: Date.now() - 60_000 },
    { name: 'readme.txt', isDirectory: false, size: 1024, mtimeMs: Date.now() - 60_000 }
  ],
  truncated: false,
  roots: { home: '/home/user', scratch: '/scratch/user' },
  resolvedPath: '/scratch/user',
  ...overrides
})

const setComputeApi = (api: Partial<Window['api']['compute']>): void => {
  // Only the api property — replacing globalThis.window breaks getComputedStyle, which the
  // radix-ui portal needs.
  Object.defineProperty(globalThis.window, 'api', {
    configurable: true,
    writable: true,
    value: { compute: api }
  })
}

const renderModal = async (): Promise<void> => {
  await act(async () => {
    root.render(<FileBrowserModal open={true} onClose={vi.fn()} initialProviderId="ssh:biowulf" />)
  })
  await flush()
}

const selectFile = async (name: string): Promise<void> => {
  const entry = Array.from(document.body.querySelectorAll<HTMLElement>('button')).find((el) =>
    el.textContent?.includes(name)
  )
  await act(async () => {
    entry?.click()
  })
}

// Go-to locations, pin-current and the bookmark list only mount while the dropdown is open.
const openGoTo = async (): Promise<void> => {
  const trigger = document.body.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
  await act(async () => {
    openRadixMenu(trigger)
  })
}

const downloadResult: LocalFile = {
  path: '/Users/user/Downloads/readme.txt',
  name: 'readme.txt',
  size: 1024,
  mimeType: 'text/plain'
}

beforeEach(() => {
  // Reset before rendering, not just after unmounting: changeLanguage settles on a promise the
  // previous afterEach did not await, so a leaked language could otherwise reach an assertion.
  switchTo('en')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({
    ...createInitialComputeState(),
    isLoaded: true,
    loadHosts: vi.fn(),
    hosts: [connectedHost()]
  })
  setComputeApi({
    listDir: vi.fn().mockResolvedValue(mockListing()),
    // One bookmark so the Bookmarks heading and its remove button are in the tree.
    bookmarksGet: vi.fn().mockResolvedValue(['/scratch/user/data']),
    bookmarksSet: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(downloadResult),
    revealInFolder: vi.fn().mockResolvedValue(undefined)
  })
  // An active project is required for the Add to project entry point to render.
  useProjectStore.setState({
    projects: [{ id: 'proj-1', name: 'My Project', createdAt: 1, updatedAt: 1 }],
    isLoaded: true,
    loadError: undefined
  } as Parameters<typeof useProjectStore.setState>[0])
  useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  switchTo('en')
  vi.restoreAllMocks()
})

describe('FileBrowserModal i18n', () => {
  it('renders the chrome and listing columns in Simplified Chinese', async () => {
    switchTo('zh-Hans')
    await renderModal()
    await openGoTo()

    const text = document.body.textContent ?? ''
    expect(text).toContain('主机')
    expect(text).toContain('前往')
    expect(text).toContain('临时目录')
    expect(text).toContain('固定当前文件夹')
    expect(text).toContain('名称')
    expect(text).toContain('大小')
    expect(text).toContain('修改时间')
    expect(text).toContain('书签')
    // Paths and host aliases are protocol values, never translated.
    expect(text).toContain('/scratch/user')
    expect(text).toContain('readme.txt')
    expect(text).not.toContain('Bookmarks')
  })

  it('renders the chrome and listing columns in Traditional Chinese', async () => {
    switchTo('zh-Hant')
    await renderModal()
    await openGoTo()

    const text = document.body.textContent ?? ''
    expect(text).toContain('主機')
    expect(text).toContain('暫存目錄')
    expect(text).toContain('釘選目前資料夾')
    expect(text).toContain('名稱')
    expect(text).toContain('修改時間')
    expect(text).toContain('書籤')
    expect(text).not.toContain('书签')
  })

  it('localizes aria labels', async () => {
    switchTo('zh-Hans')
    await renderModal()
    await openGoTo()

    expect(document.body.querySelector('[aria-label="远程文件浏览器"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="刷新目录列表"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="当前目录路径"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="目录内容"]')).not.toBeNull()
    // Interpolated: the path is a protocol value inside a translated label.
    expect(document.body.querySelector('[aria-label="移除书签 /scratch/user/data"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Remote file browser"]')).toBeNull()
  })

  it('localizes the empty and truncated notices', async () => {
    setComputeApi({
      listDir: vi.fn().mockResolvedValue(mockListing({ entries: [], truncated: true })),
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined)
    })
    switchTo('zh-Hant')
    await renderModal()

    const text = document.body.textContent ?? ''
    expect(text).toContain('空目錄')
    expect(text).toContain('僅顯示前 5,000 個項目')
  })

  it('localizes the bucketed Modified column', async () => {
    switchTo('zh-Hans')
    await renderModal()
    expect(document.body.textContent).toContain('1 分')

    // Age labels are recomputed at render, so a language switch alone must retranslate them.
    switchTo('zh-Hant')
    await flush()
    expect(document.body.textContent).toContain('1 分')
    expect(document.body.textContent).not.toContain('1m')
  })

  it('localizes the error banner while passing the backend detail through verbatim', async () => {
    setComputeApi({
      listDir: vi.fn().mockRejectedValue({
        message: 'Connection refused',
        remoteFsError: { detail: 'Connection refused', remoteKind: 'connection' }
      }),
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined)
    })
    switchTo('zh-Hans')
    await renderModal()

    const text = document.body.textContent ?? ''
    expect(text).toContain('无法打开此路径。')
    expect(text).toContain('重试')
    // Backend text is not ours to translate.
    expect(text).toContain('Connection refused')
    expect(text).not.toContain("Couldn't open this path.")
  })

  it('localizes the detail panel', async () => {
    switchTo('zh-Hant')
    await renderModal()
    await selectFile('readme.txt')

    const text = document.body.textContent ?? ''
    expect(text).toContain('詳情')
    expect(text).toContain('類型')
    expect(text).toContain('無預覽')
    expect(text).toContain('下載')
    expect(text).toContain('複製路徑')
    expect(text).toContain('加入專案')
    expect(text).toContain('文字')
    // KB stays a unit symbol.
    expect(text).toContain('1.0 KB')
    expect(text).not.toContain('Copy path')
  })

  it('retranslates the download success banner after a language switch', async () => {
    const download = vi.fn().mockResolvedValue(downloadResult)
    setComputeApi({
      listDir: vi.fn().mockResolvedValue(mockListing()),
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined),
      download,
      revealInFolder: vi.fn().mockResolvedValue(undefined)
    })
    await renderModal()
    await selectFile('readme.txt')

    const downloadButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((el) => el.getAttribute('aria-label')?.includes('OS Downloads'))
    await act(async () => {
      downloadButton?.click()
    })
    await flush()

    expect(document.body.textContent).toContain('Saved to Downloads: readme.txt')

    // The banner outlives the event that produced it, so it is stored as a key + params and must
    // follow a later language switch instead of freezing in the download-time language.
    switchTo('zh-Hans')
    await flush()
    const text = document.body.textContent ?? ''
    expect(text).toContain('已保存到下载文件夹：readme.txt')
    expect(text).toContain('在访达中显示')
    expect(text).not.toContain('Saved to Downloads')
  })
})
