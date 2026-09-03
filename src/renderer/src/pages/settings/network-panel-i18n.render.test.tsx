// @vitest-environment jsdom
// Proves the Network panel reads its copy from the catalog rather than shipping literals: the list
// view and the configure form each render in English, then re-render in Chinese after a language
// change. Catalog parity tests can't catch a component that never calls t() at all, and they can't
// catch zh-Hant quietly falling back to zh-Hans — so both scripts are asserted separately.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { NetworkPanel } from './NetworkPanel'

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

const noop = (): void => {}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({
    packageMirror: undefined,
    setPackageMirror: async () => {}
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  switchTo('en')
})

describe('NetworkPanel list view', () => {
  it('translates the heading and the unconfigured status, and re-renders on language change', () => {
    render(<NetworkPanel view={{ kind: 'list' }} onNavigate={noop} />)
    expect(container.textContent).toContain('Package mirror')
    expect(container.textContent).toContain('Not configured')
    expect(container.textContent).toContain('Configure')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('软件包镜像')
    expect(container.textContent).toContain('未配置')
    expect(container.textContent).toContain('配置')
    expect(container.textContent).not.toContain('Package mirror')
    expect(container.textContent).not.toContain('Not configured')

    // zh-Hant has its own catalog; a fallback to zh-Hans would leave Simplified glyphs on screen.
    switchTo('zh-Hant')
    expect(container.textContent).toContain('套件鏡像')
    expect(container.textContent).toContain('未設定')
    expect(container.textContent).not.toContain('软件包镜像')
  })

  it('translates the configured status with the host list passed through verbatim', () => {
    useSettingsStore.setState({ packageMirror: { condaChannel: 'https://mirror.test/conda' } })
    render(<NetworkPanel view={{ kind: 'list' }} onNavigate={noop} />)
    expect(container.textContent).toContain('Fetching packages from https://mirror.test/conda')
    expect(container.textContent).toContain('Edit')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('正在从 https://mirror.test/conda 获取软件包')
    expect(container.textContent).toContain('编辑')
    expect(container.textContent).not.toContain('Fetching packages')
  })
})

describe('NetworkPanel mirror view', () => {
  it('translates the field labels, the optional marker, and the footer buttons', () => {
    render(<NetworkPanel view={{ kind: 'mirror' }} onNavigate={noop} />)
    expect(container.textContent).toContain('Conda channel mirror')
    expect(container.textContent).toContain('Python package index (pip)')
    expect(container.textContent).toContain('CA bundle path')
    expect(container.textContent).toContain('(optional)')
    expect(container.textContent).toContain('Save')
    expect(container.textContent).toContain('Cancel')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('Conda 频道镜像')
    expect(container.textContent).toContain('Python 软件包索引（pip）')
    expect(container.textContent).toContain('CA 证书包路径')
    expect(container.textContent).toContain('（选填）')
    expect(container.textContent).toContain('保存')
    expect(container.textContent).toContain('取消')
    expect(container.textContent).not.toContain('CA bundle path')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('CA 憑證包路徑')
    expect(container.textContent).toContain('（選填）')
    expect(container.textContent).toContain('儲存')
    expect(container.textContent).not.toContain('CA 证书包路径')
  })

  it('keeps the example placeholders untranslated in every locale', () => {
    render(<NetworkPanel view={{ kind: 'mirror' }} onNavigate={noop} />)
    const placeholders = (): string[] =>
      Array.from(container.querySelectorAll('input')).map((input) => input.placeholder)
    expect(placeholders()).toContain('/path/to/corp-ca-bundle.pem')

    switchTo('zh-Hant')
    expect(placeholders()).toContain('/path/to/corp-ca-bundle.pem')
  })

  it('translates a safe save failure without exposing backend details', async () => {
    const diagnostic = 'EACCES: open /Users/researcher/private/ca-bundle.pem'
    useSettingsStore.setState({
      setPackageMirror: async () => {
        throw new Error(diagnostic)
      }
    })
    render(<NetworkPanel view={{ kind: 'mirror' }} onNavigate={noop} />)
    switchTo('zh-Hans')

    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === '保存'
    )
    await act(async () => save?.click())

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('无法保存软件包镜像。')
    expect(container.textContent).not.toContain(diagnostic)

    switchTo('zh-Hant')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('無法儲存套件鏡像。')
  })
})
