// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ComposerContextUsage } from './ComposerContextUsage'

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
})

describe('ComposerContextUsage', () => {
  it('stays hidden until the current agent context reports usage', () => {
    act(() => root.render(<ComposerContextUsage contextUsage={undefined} />))

    expect(container.querySelector('button')).toBeNull()
  })

  it('shows current context occupancy as a percentage with token details', async () => {
    act(() => root.render(<ComposerContextUsage contextUsage={{ used: 24_890, size: 200_000 }} />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context used: 12%"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('12%')

    await act(async () => {
      trigger?.focus()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Context window')
    expect(document.body.textContent).toContain('25k / 200k tokens (12%)')
  })
})
