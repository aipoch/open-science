// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RepairFrameworkDialog } from './RepairFrameworkDialog'

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

describe('RepairFrameworkDialog', () => {
  it('uses shared settings dialog chrome while keeping the repair action', () => {
    const onCancel = vi.fn()
    const onRepair = vi.fn()

    act(() =>
      root.render(
        <RepairFrameworkDialog
          name="Codex"
          sources={[
            {
              id: 'managed',
              label: 'Managed',
              description: 'Install the bundled runtime.',
              displayCommand: '',
              requiresNpm: false
            }
          ]}
          installing={false}
          disabled={false}
          npmAvailable
          blockedInstallSources={{}}
          onCancel={onCancel}
          onRepair={onRepair}
        />
      )
    )

    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const repair = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Repair')
    )

    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
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
    expect(dialog?.textContent).toContain('Codex needs repair')
    expect(repair).not.toBeNull()
  })
})
