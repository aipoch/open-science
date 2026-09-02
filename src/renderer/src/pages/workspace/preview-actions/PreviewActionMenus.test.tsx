// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { PreviewMenuItems, PreviewPointerMenu } from './PreviewActionMenus'
import { LOCAL_PREVIEW_MENU_RECIPE, resolvePreviewMenuEntries } from './preview-action-model'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('PreviewMenuItems', () => {
  it('renders resolved actions and separators in order', async () => {
    const execute = (): void => undefined
    const entries = resolvePreviewMenuEntries(LOCAL_PREVIEW_MENU_RECIPE, {
      'copy-path': { execute },
      download: { execute, disabled: true },
      'save-as-artifact': { execute }
    })

    await act(async () => {
      root.render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <PreviewMenuItems
              entries={entries}
              getActionId={(entry) => entry.capability}
              onSelect={() => undefined}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )
      await Promise.resolve()
    })

    expect(
      Array.from(document.body.querySelectorAll('[data-capability], [role="separator"]')).map(
        (element) => element.getAttribute('data-capability') ?? 'separator'
      )
    ).toEqual(['copy-path', 'save-as-artifact', 'separator', 'download'])
    expect(
      document.body.querySelector('[data-capability="download"]')?.getAttribute('aria-disabled')
    ).toBe('true')
  })

  it('anchors a context menu at the requested viewport coordinates', async () => {
    const entries = resolvePreviewMenuEntries(LOCAL_PREVIEW_MENU_RECIPE, {
      download: { execute: (): void => undefined }
    })

    await act(async () => {
      root.render(
        <PreviewPointerMenu
          entries={entries}
          getActionId={(entry) => entry.capability}
          pointer={{ x: 37, y: 51 }}
          testId="preview-context-menu"
          onSelect={() => undefined}
          onClose={() => undefined}
          onRestoreFocus={() => undefined}
        />
      )
      await Promise.resolve()
    })

    expect(document.body.querySelector('[data-testid="preview-context-menu"]')).not.toBeNull()
    const anchor = document.body.querySelector<HTMLElement>(
      '[data-testid="preview-context-menu-anchor"]'
    )
    expect(anchor?.style.cssText).toContain('left: 37px; top: 51px')
    expect(anchor?.parentElement).toBe(document.body)
  })
})
