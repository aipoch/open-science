// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SwitchFrameworkDialog } from './SwitchFrameworkDialog'

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

const button = (text: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text
  )

describe('SwitchFrameworkDialog', () => {
  it('uses shared settings dialog chrome', () => {
    act(() =>
      root.render(
        <SwitchFrameworkDialog targetName="Codex" onCancel={vi.fn()} onConfirm={vi.fn()} />
      )
    )

    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const source = readFileSync(resolve(__dirname, 'SwitchFrameworkDialog.tsx'), 'utf8')

    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(source).toContain('dialogOverlayClassName')
    expect(source).toContain('dialogPanelClassName')
  })

  it('fires confirm and cancel through the existing action buttons', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()

    act(() =>
      root.render(
        <SwitchFrameworkDialog targetName="Codex" onCancel={onCancel} onConfirm={onConfirm} />
      )
    )
    act(() => button('Switch')?.click())

    expect(onConfirm).toHaveBeenCalledTimes(1)
    onCancel.mockClear()

    act(() =>
      root.render(
        <SwitchFrameworkDialog targetName="OpenCode" onCancel={onCancel} onConfirm={onConfirm} />
      )
    )
    act(() => button('Cancel')?.click())

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
