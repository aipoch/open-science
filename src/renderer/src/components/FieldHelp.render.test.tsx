// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FieldHelp } from './FieldHelp'

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
  document.body.innerHTML = ''
})

describe('FieldHelp', () => {
  it('accepts ReactNode tooltip content and exposes it on keyboard focus', async () => {
    await act(async () => {
      root.render(
        <FieldHelp
          content={
            <>
              <span>Provider details</span>
              <code>/v1/messages</code>
            </>
          }
        />
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="field-help"]')

    await act(async () => {
      trigger?.focus()
    })

    expect(document.body.textContent).toContain('Provider details')
    expect(document.body.textContent).toContain('/v1/messages')
  })

  it('uses a small light neutral trigger with stronger hover, focus, and open states', async () => {
    await act(async () => {
      root.render(<FieldHelp content="More details" />)
    })

    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="field-help"]')

    expect(trigger?.getAttribute('aria-label')).toBe('More information')
    expect(trigger?.className).toContain('size-[18px]')
    expect(trigger?.className).toContain('rounded-full')
    expect(trigger?.className).toContain('text-muted-foreground/50')
    expect(trigger?.className).toContain('hover:bg-muted')
    expect(trigger?.className).toContain('hover:text-foreground')
    expect(trigger?.className).toContain('focus-visible:bg-muted')
    expect(trigger?.className).toContain('data-[state=delayed-open]:bg-muted')
    expect(trigger?.className).not.toContain('primary')
  })
})
