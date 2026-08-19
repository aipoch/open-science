// @vitest-environment jsdom
// The editor's translation risks are the validation messages (computed in a useMemo, so they go
// stale unless `t` is a dependency), the reserved-prefix list (joined with a locale-specific "or",
// not a hardcoded English one), the two <Trans> hints that wrap a path in <code>, and the footer
// verb that switches between Publish and Save.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { SkillEditor } from './SkillEditor'

let container: HTMLDivElement
let root: Root

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

const blank = { name: '', description: '', body: '' }

const render = (initial: Parameters<typeof SkillEditor>[0]['initial']): void => {
  act(() => {
    root.render(<SkillEditor initial={initial} onCancel={vi.fn()} onSave={vi.fn()} />)
  })
}

// React tracks a controlled input's last value on the node, so assigning `.value` directly is
// treated as a no-op change. Going through the prototype setter is what makes onChange fire.
const setValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
}

// The name doubles as the invocation identity on create, so it carries the slug validation the
// editor renders inline. Selected by position rather than by aria-label, which is itself translated
// and would stop matching the moment the test switches language.
const typeName = (value: string): void => {
  const input = container.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')
  if (!input) throw new Error('skill name input not found')
  act(() => {
    setValue(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({ skills: [{ id: 'personal-taken', name: 'Taken' }] } as never)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  switchTo('en')
})

describe('SkillEditor copy', () => {
  it('translates the section headings and the create-mode footer verb', () => {
    render(blank)

    // Open Advanced settings to reveal the References section
    const advancedButton = container.querySelector(
      'button[aria-controls="skill-advanced-settings"]'
    )
    act(() => {
      advancedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('References')
    expect(container.textContent).toContain('Publish')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('参考文件')
    expect(container.textContent).toContain('发布')

    switchTo('zh-Hant')
    // 參考檔案, not 參考文件 — `file` is 檔案 in Traditional, and 文件 there means `document`.
    expect(container.textContent).toContain('參考檔案')
  })

  it('uses Save instead of Publish when editing an existing skill', () => {
    render({ ...blank, id: 'personal-alpha', name: 'Alpha' })
    expect(container.textContent).toContain('Save')
    expect(container.textContent).not.toContain('Publish')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('儲存')
    expect(container.textContent).not.toContain('發布')
  })

  it('re-renders validation messages on a language switch', () => {
    render(blank)
    expect(container.textContent).toContain('Name is required.')

    // The message comes out of a useMemo; without `t` in its deps it would stay English here.
    switchTo('zh-Hans')
    expect(container.textContent).toContain('名称为必填项。')
    expect(container.textContent).not.toContain('Name is required.')

    typeName('Bad Slug')
    expect(container.textContent).toContain('最多 64 个字符，仅可使用小写字母、数字和单个连字符。')

    typeName('taken')
    expect(container.textContent).toContain('已存在同名技能。')
  })

  it('joins the reserved prefixes with the locale’s own disjunction', () => {
    render(blank)
    typeName('os-thing')
    expect(container.textContent).toContain("Can't start with os- or mcp-.")

    // zh writes 「或」 with no surrounding spaces, so a hardcoded ' or ' would read wrong.
    switchTo('zh-Hant')
    expect(container.textContent).toContain('不能以 os-或mcp- 開頭。')
    expect(container.textContent).not.toContain(' or ')
  })

  it('keeps the literal path inside <code> in the reference hint', () => {
    render(blank)

    // Open Advanced settings to reveal the References section
    const advancedButton = container.querySelector(
      'button[aria-controls="skill-advanced-settings"]'
    )
    act(() => {
      advancedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const codes = (): string[] =>
      [...container.querySelectorAll('code')].map((node) => node.textContent ?? '')
    expect(codes()).toEqual(['---', 'references/'])
    expect(container.textContent).toContain('Saved under')

    switchTo('zh-Hans')
    // Paths and the frontmatter fence are protocol, not prose — identical in every locale.
    expect(codes()).toEqual(['---', 'references/'])
    expect(container.textContent).toContain('保存在技能的')
  })
})
