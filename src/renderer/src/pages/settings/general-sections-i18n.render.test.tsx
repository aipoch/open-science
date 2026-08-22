// @vitest-environment jsdom
// Proves the two General-panel sections that sit outside the panel body — About (app version +
// update control) and App icon — read their copy from the catalog rather than shipping literals.
// Catalog parity tests can't catch a component that never calls t(), and they can't catch zh-Hant
// quietly falling back to zh-Hans, so both scripts are asserted separately. The About status line
// is a switch over update states, so each interpolated branch is rendered rather than just one.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { useUpdateStore } from '@/stores/update-store'
import { AppIconSection } from './AppIconSection'
import { AppVersionSection } from './AppVersionSection'

vi.mock('@/assets/logo.png', () => ({ default: 'logo.png' }))

let container: HTMLDivElement
let root: Root

const render = (element: React.JSX.Element): void => {
  act(() => {
    root.render(element)
  })
}

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  useUpdateStore.setState({
    appInfo: { name: 'Open Science', version: '0.2.0', copyright: '© 2026 AIPOCH.' },
    status: { state: 'up-to-date', current: '0.2.0', latest: '0.2.0' }
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  switchTo('en')
})

describe('AppVersionSection', () => {
  it('translates the section title and the check button, and re-renders on language change', () => {
    render(<AppVersionSection />)
    expect(container.textContent).toContain('About')
    expect(container.textContent).toContain('Check now')
    expect(container.textContent).toContain('You are on the latest version')
    expect(container.textContent).toContain('Help Center')
    expect(container.textContent).toContain('Release notes')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('关于')
    expect(container.textContent).toContain('立即检查')
    expect(container.textContent).toContain('已是最新版本')
    expect(container.textContent).toContain('帮助中心')
    expect(container.textContent).toContain('发布说明')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('關於')
    expect(container.textContent).toContain('立即檢查')
    expect(container.textContent).toContain('說明中心')
    expect(container.textContent).toContain('版本資訊')
  })

  it('interpolates the version into the available status and the update button', () => {
    useUpdateStore.setState({
      status: { state: 'available', current: '0.2.0', latest: '0.3.0' }
    })
    render(<AppVersionSection />)
    expect(container.textContent).toContain('New version 0.3.0 is available')
    expect(container.textContent).toContain('Update to 0.3.0')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('新版本 0.3.0 可用')
    expect(container.textContent).toContain('更新到 0.3.0')
  })

  it('interpolates download progress in both the status line and the button', () => {
    useUpdateStore.setState({
      status: { state: 'downloading', current: '0.2.0', latest: '0.3.0', progress: 42 }
    })
    render(<AppVersionSection />)
    expect(container.textContent).toContain('Downloading… 42%')
    expect(container.textContent).toContain('Downloading 42%')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('正在下載… 42%')
    expect(container.textContent).toContain('正在下載 42%')
  })

  it('passes a backend-supplied update error through verbatim in every locale', () => {
    useUpdateStore.setState({
      status: { state: 'error', current: '0.2.0', latest: '0.2.0', error: 'ENOTFOUND registry' }
    })
    render(<AppVersionSection />)
    expect(container.textContent).toContain('ENOTFOUND registry')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('ENOTFOUND registry')
  })
})

describe('AppIconSection', () => {
  beforeEach(() => {
    useSettingsStore.setState({ appIconVariant: 'light' })
    ;(window as unknown as { api: unknown }).api = {
      settings: { listAppIcons: vi.fn().mockResolvedValue([]) }
    }
  })

  it('translates the title, description, and platform note, and re-renders on language change', () => {
    render(<AppIconSection />)
    expect(container.textContent).toContain('App icon')
    expect(container.textContent).toContain('Choose the built-in icon shown in app windows')
    expect(container.textContent).toContain('is part of the installed app and stays the same')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('应用图标')
    expect(container.textContent).toContain('选择应用窗口中显示的内置图标')
    expect(container.textContent).toContain('资源管理器')

    // zh-Hant must not fall back to zh-Hans: 图标→圖示, 资源管理器→檔案總管.
    switchTo('zh-Hant')
    expect(container.textContent).toContain('應用圖示')
    expect(container.textContent).toContain('檔案總管')
    expect(container.textContent).not.toContain('资源管理器')
  })

  it('labels the radiogroup from the catalog', () => {
    render(<AppIconSection />)
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
      'App icon'
    )

    switchTo('zh-Hant')
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
      '應用圖示'
    )
  })
})
