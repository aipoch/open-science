// @vitest-environment jsdom
// Proves the Storage panel and its migration modal read copy from the catalog rather than shipping
// literals. Two things here are easy to get wrong and are asserted directly: the disk-usage category
// labels come from a module-level map, which must hold catalog *keys* (a map of resolved strings is
// evaluated once at import and would pin the first render's language), and the move/adopt notices are
// <Trans> strings whose <em> tags must survive translation. zh-Hant is asserted separately from
// zh-Hans because no cross-script fallback is configured.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { StoragePanel } from './StoragePanel'
import { StorageMigrationModal } from './StorageMigrationModal'

let container: HTMLDivElement
let root: Root

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

const USAGE = {
  categories: [
    { key: 'artifacts', bytes: 20_000_000 },
    { key: 'runtime', bytes: 10_000_000 },
    { key: 'workspaces', bytes: 5_600_000 }
  ],
  totalBytes: 35_600_000
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({
    environmentCheck: undefined,
    environmentCheckError: undefined,
    checkEnvironment: async () => undefined
  })
  ;(window as unknown as { api: unknown }).api = {
    platform: 'darwin',
    storage: {
      getInfo: vi.fn().mockResolvedValue({
        dataRoot: '/home/u/OpenScience',
        defaultDataRoot: '/home/u/OpenScience',
        defaultParent: '/home/u',
        isDefault: true,
        usage: USAGE,
        availableBytes: 500_000_000_000
      }),
      revealAppStorage: vi.fn().mockResolvedValue({ revealed: true }),
      pickDirectory: vi.fn().mockResolvedValue(null),
      inspectDataRoot: vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' }),
      setDataRootAndRelaunch: vi.fn().mockResolvedValue({ ok: true }),
      detectActive: vi.fn().mockResolvedValue([]),
      migrate: vi.fn(() => new Promise(() => {})),
      cancelMigrate: vi.fn().mockResolvedValue(undefined),
      onProgress: vi.fn(() => () => {})
    }
  }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  switchTo('en')
  delete (window as unknown as { api?: unknown }).api
})

describe('StoragePanel copy', () => {
  it('translates the data-location section and re-renders on language change', async () => {
    act(() => {
      root.render(<StoragePanel />)
    })
    await flush()
    expect(container.textContent).toContain('Data location')
    expect(container.textContent).toContain('Change location')
    expect(container.textContent).toContain('35.6 MB on disk · default location')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('数据位置')
    expect(container.textContent).toContain('更改位置')
    // Byte units stay untranslated; only the surrounding sentence changes.
    expect(container.textContent).toContain('占用磁盘 35.6 MB · 默认位置')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('資料位置')
    expect(container.textContent).toContain('變更位置')
    expect(container.textContent).not.toContain('数据位置')
  })

  it('resolves disk-usage category labels per render, not once at import', async () => {
    act(() => {
      root.render(<StoragePanel />)
    })
    await flush()
    expect(container.textContent).toContain('Artifacts')
    expect(container.textContent).toContain('Session workspaces')
    expect(container.textContent).toContain('Total')
    expect(container.textContent).toContain('Available on disk')

    // The module-level label map is built at import time. If it held resolved strings instead of
    // keys, these would still read English after the switch.
    switchTo('zh-Hant')
    expect(container.textContent).toContain('產物')
    expect(container.textContent).toContain('工作階段工作區')
    expect(container.textContent).toContain('總計')
    expect(container.textContent).not.toContain('Artifacts')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('产物')
    expect(container.textContent).toContain('会话工作区')
  })

  it('keeps the emphasis markup and the size when interpolating the move notice', async () => {
    ;(
      window as unknown as { api: { storage: { pickDirectory: ReturnType<typeof vi.fn> } } }
    ).api.storage.pickDirectory.mockResolvedValue('/mnt/data')
    act(() => {
      root.render(<StoragePanel />)
    })
    await flush()

    // Open the editor: Change location → warning dialog → Continue.
    const openEditor = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Change location')
    )
    act(() => openEditor?.click())
    const proceed = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Continue'
    )
    act(() => proceed?.click())
    await flush()

    // 25.6 MB = everything except runtime/, which is rebuilt rather than moved.
    expect(container.textContent).toContain('Your existing data (~25.6 MB) will be moved')
    expect([...container.querySelectorAll('strong')].length).toBeGreaterThan(0)
    expect(container.textContent).toContain('Python/R environments are rebuilt')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('你現有的資料（約 25.6 MB）將被移動')
    expect([...container.querySelectorAll('strong')].length).toBeGreaterThan(0)
  })
})

describe('StorageMigrationModal copy', () => {
  it('translates the detecting stage and re-renders on language change', async () => {
    act(() => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={vi.fn()} />)
    })
    expect(document.body.textContent).toContain('Checking for running sessions…')

    switchTo('zh-Hans')
    expect(document.body.textContent).toContain('正在检查运行中的会话…')

    switchTo('zh-Hant')
    expect(document.body.textContent).toContain('正在檢查執行中的工作階段…')
    expect(document.body.textContent).not.toContain('正在检查运行中的会话…')
    await flush()
  })

  it('resolves migration phase labels per render, not once at import', async () => {
    let emit: ((progress: { phase: string; percent: number }) => void) | undefined
    ;(
      window as unknown as { api: { storage: { onProgress: ReturnType<typeof vi.fn> } } }
    ).api.storage.onProgress.mockImplementation((handler: typeof emit) => {
      emit = handler
      return () => {}
    })

    act(() => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={vi.fn()} />)
    })
    await flush()
    act(() => emit?.({ phase: 'copy', percent: 40 }))

    expect(document.body.textContent).toContain('Copying files…')
    expect(document.body.textContent).toContain('Elapsed 0:00')

    switchTo('zh-Hant')
    expect(document.body.textContent).toContain('正在複製檔案…')
    expect(document.body.textContent).toContain('已用 0:00')
    expect(document.body.textContent).not.toContain('Copying files…')
  })
})
