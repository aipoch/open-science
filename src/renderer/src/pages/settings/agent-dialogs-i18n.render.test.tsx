// @vitest-environment jsdom
// Proves the two framework dialogs and the tool-permission pill read copy from the catalog. The
// framework name is interpolated, never translated — it's a product name supplied by the caller, and
// switchDialog.description interpolates it twice, so a catalog that drops one {{name}} would leave a
// gap mid-sentence. zh-Hant is asserted separately because no cross-script fallback is configured.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { RepairFrameworkDialog } from './RepairFrameworkDialog'
import { SwitchFrameworkDialog } from './SwitchFrameworkDialog'
import { ToolPermissionControl } from './ToolPermissionControl'

let container: HTMLDivElement
let root: Root

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
  act(() => root.unmount())
  container.remove()
  switchTo('en')
})

describe('SwitchFrameworkDialog copy', () => {
  it('interpolates the framework name without translating it', () => {
    act(() => {
      root.render(
        <SwitchFrameworkDialog targetName="Codex" onCancel={vi.fn()} onConfirm={vi.fn()} />
      )
    })
    expect(document.body.textContent).toContain('Switch to Codex?')
    expect(document.body.textContent).toContain('Switch')
    expect(document.body.textContent).toContain('Cancel')
    // Interpolated twice — the second occurrence is mid-sentence in the description.
    expect(document.body.textContent?.match(/Codex/g)?.length).toBeGreaterThanOrEqual(2)

    switchTo('zh-Hans')
    expect(document.body.textContent).toContain('切换到 Codex？')
    expect(document.body.textContent).toContain('取消')
    expect(document.body.textContent?.match(/Codex/g)?.length).toBeGreaterThanOrEqual(2)

    // zh-Hant must not fall back to zh-Hans: 切换→切換, 会话→工作階段.
    switchTo('zh-Hant')
    expect(document.body.textContent).toContain('切換到 Codex？')
    expect(document.body.textContent).toContain('工作階段')
    expect(document.body.textContent).not.toContain('切换到 Codex？')
  })
})

describe('RepairFrameworkDialog copy', () => {
  it('translates the title and description around the framework name', () => {
    act(() => {
      root.render(
        <RepairFrameworkDialog
          name="Claude Code"
          sources={[]}
          installing={false}
          disabled={false}
          npmAvailable
          blockedInstallSources={{}}
          onCancel={vi.fn()}
          onRepair={vi.fn()}
        />
      )
    })
    expect(document.body.textContent).toContain('Claude Code needs repair')
    expect(document.body.textContent).toContain('Repair this agent before selecting it.')

    switchTo('zh-Hant')
    expect(document.body.textContent).toContain('Claude Code 需要修復')
    expect(document.body.textContent).toContain('請先修復該智能體')
    expect(document.body.textContent).not.toContain('needs repair')
  })
})

describe('ToolPermissionControl copy', () => {
  it('translates each segment label and its matching aria-label', () => {
    act(() => {
      root.render(
        <ToolPermissionControl value="ask" onChange={vi.fn()} label="Permission for list_marts" />
      )
    })
    const ariaLabels = (): (string | null)[] =>
      [...container.querySelectorAll('[role="radio"]')].map((node) =>
        node.getAttribute('aria-label')
      )
    expect(ariaLabels()).toEqual(['Always allow', 'Require approval', 'Block'])

    switchTo('zh-Hans')
    expect(ariaLabels()).toEqual(['始终允许', '需要批准', '阻止'])

    switchTo('zh-Hant')
    expect(ariaLabels()).toEqual(['一律允許', '需要核准', '封鎖'])
  })
})
