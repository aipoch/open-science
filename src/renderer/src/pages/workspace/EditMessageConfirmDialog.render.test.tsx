// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EditMessageConfirmDialog } from './EditMessageConfirmDialog'

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
    (candidate) => candidate.textContent?.trim() === text
  )

describe('EditMessageConfirmDialog', () => {
  it('uses shared dialog chrome while preserving confirmation actions', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()

    act(() =>
      root.render(
        <EditMessageConfirmDialog
          open
          subsequentTurns={3}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )
    )

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('p-0')
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-b border-border-300/90')
      )
    ).toBe(true)
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-t border-border-300/90')
      )
    ).toBe(true)
    expect(dialog?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')).not.toBeNull()
    expect(dialog?.textContent).toContain('3 turns')

    act(() => button('Branch and resend')?.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
