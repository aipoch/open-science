// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UninstallRuntimeDialog } from './UninstallRuntimeDialog'

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
  // Radix portals the dialog into document.body; clear it between cases.
  document.body.innerHTML = ''
})

const button = (text: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text
  )

describe('UninstallRuntimeDialog Codex variant', () => {
  it('uses shared settings dialog chrome', () => {
    act(() =>
      root.render(
        <UninstallRuntimeDialog
          framework="codex"
          isUninstalling={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
    )

    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const source = readFileSync(resolve(__dirname, 'UninstallRuntimeDialog.tsx'), 'utf8')

    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(source).toContain('dialogOverlayClassName')
    expect(source).toContain('dialogPanelClassName')
    expect(source).not.toContain('backdrop-blur')
  })

  it('renders Codex-specific copy and title when the framework is codex', () => {
    act(() =>
      root.render(
        <UninstallRuntimeDialog
          framework="codex"
          isUninstalling={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
    )

    expect(document.body.textContent).toContain('Uninstall Codex?')
    // The body copy names Codex both for the managed removal and the untouched self-install.
    expect(document.body.textContent).toContain(
      'This removes the Codex runtime this app downloaded and manages. A separate Codex you installed yourself is not affected.'
    )
    // No other framework name should leak into the Codex dialog.
    expect(document.body.textContent).not.toContain('Claude')
    expect(document.body.textContent).not.toContain('OpenCode')
  })

  it('fires onConfirm when the Uninstall button is clicked', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    act(() =>
      root.render(
        <UninstallRuntimeDialog
          framework="codex"
          isUninstalling={false}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )
    )

    act(() => button('Uninstall')?.click())

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('fires onCancel (not onConfirm) when the Cancel button is clicked', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    act(() =>
      root.render(
        <UninstallRuntimeDialog
          framework="codex"
          isUninstalling={false}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )
    )

    act(() => button('Cancel')?.click())

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('shows the in-flight label and disables both actions while uninstalling', () => {
    const onConfirm = vi.fn()
    act(() =>
      root.render(
        <UninstallRuntimeDialog
          framework="codex"
          isUninstalling={true}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      )
    )

    const confirm = button('Uninstalling…')
    expect(confirm?.disabled).toBe(true)
    expect(button('Cancel')?.disabled).toBe(true)

    act(() => confirm?.click())
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
