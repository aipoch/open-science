// @vitest-environment jsdom
// Proves the shared components read from the catalog rather than shipping literals: each renders in
// English, then re-renders in Chinese after a language change. Catalog parity tests can't catch a
// component that never calls t() at all.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { i18next } from '@/i18n'
import { JobStatusBadge } from './JobStatusBadge'
import { JobTerminalOutput } from './JobTerminalOutput'
import { DataRootWarning } from './DataRootWarning'
import { ThemeSegmentedControl } from './ThemeControls'

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
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  switchTo('en')
})

describe('JobStatusBadge', () => {
  it('translates the status label and re-renders on language change', () => {
    render(<JobStatusBadge status="running" />)
    expect(container.textContent).toBe('Running')

    switchTo('zh-Hans')
    expect(container.textContent).toBe('运行中')

    switchTo('zh-Hant')
    expect(container.textContent).toBe('執行中')
  })

  it('distinguishes dispatch from waiting in the remote queue', () => {
    switchTo('zh-Hans')
    render(<JobStatusBadge status="submitted" />)
    expect(container.textContent).toBe('正在提交')

    render(<JobStatusBadge status="queued" />)
    expect(container.textContent).toBe('正在队列中等待')
  })
})

describe('JobTerminalOutput', () => {
  it('translates its own empty state but honours an explicit override', () => {
    switchTo('zh-Hans')
    render(<JobTerminalOutput content={undefined} />)
    expect(container.textContent).toBe('暂无输出。')

    render(<JobTerminalOutput content={undefined} emptyMessage="caller wins" />)
    expect(container.textContent).toBe('caller wins')
  })
})

describe('DataRootWarning', () => {
  it('interpolates the app name into the translated advisory', () => {
    switchTo('zh-Hans')
    render(<DataRootWarning />)

    // The app name is a product noun and stays Latin in every locale.
    expect(container.textContent).toContain('Open Science')
    expect(container.textContent).toContain('不要移动、重命名或删除其中的文件')
  })
})

describe('reviewer count strings', () => {
  it('picks the right plural form per locale', () => {
    switchTo('en')
    expect(
      i18next.t('{{count}} findings', { defaultValue_one: '{{count}} finding', count: 1 })
    ).toBe('1 finding')
    expect(
      i18next.t('{{count}} findings', { defaultValue_one: '{{count}} finding', count: 3 })
    ).toBe('3 findings')

    // Chinese has one plural category; both counts must resolve, not fall back to the raw key.
    switchTo('zh-Hans')
    expect(
      i18next.t('{{count}} findings', { defaultValue_one: '{{count}} finding', count: 1 })
    ).toBe('1 项发现')
    expect(
      i18next.t('{{count}} findings', { defaultValue_one: '{{count}} finding', count: 3 })
    ).toBe('3 项发现')
    expect(i18next.t('{{count}} checks', { defaultValue_one: '{{count}} check', count: 1 })).toBe(
      '1 项检查'
    )
  })
})

describe('remote job badge strings', () => {
  it('pluralizes the job counts through the catalog', () => {
    switchTo('en')
    expect(i18next.t('{{count}} jobs', { defaultValue_one: '{{count}} job', count: 1 })).toBe(
      '1 job'
    )
    expect(i18next.t('{{count}} jobs', { defaultValue_one: '{{count}} job', count: 4 })).toBe(
      '4 jobs'
    )
    expect(
      i18next.t('{{count}} running remote jobs', {
        defaultValue_one: '{{count}} running remote job',
        count: 1
      })
    ).toBe('1 running remote job')

    switchTo('zh-Hant')
    expect(i18next.t('{{count}} jobs', { defaultValue_one: '{{count}} job', count: 1 })).toBe(
      '1 個任務'
    )
    expect(i18next.t('{{count}} jobs', { defaultValue_one: '{{count}} job', count: 4 })).toBe(
      '4 個任務'
    )
  })
})

describe('ThemeSegmentedControl', () => {
  it('translates all three options and the group label', () => {
    switchTo('zh-Hant')
    render(<ThemeSegmentedControl />)

    const group = container.querySelector('[role="radiogroup"]')
    expect(group?.getAttribute('aria-label')).toBe('主題')

    const labels = Array.from(container.querySelectorAll('[role="radio"]')).map(
      (radio) => radio.textContent
    )
    expect(labels).toEqual(['系統', '淺色', '深色'])
  })
})
