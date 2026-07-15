// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClaudeStatusCard } from './ClaudeStatusCard'

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

const render = (embedded = false): void => {
  act(() => {
    root.render(
      <ClaudeStatusCard
        claude={{ resolvedPath: '/bin/claude', version: '2.1.0' }}
        claudeReady
        isDetecting={false}
        onDetect={vi.fn()}
        embedded={embedded}
      />
    )
  })
}

describe('ClaudeStatusCard surface', () => {
  it('uses shadcn card and button slots', () => {
    render()

    expect(container.querySelector('[data-slot="card"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="button"]')).not.toBeNull()
  })

  it('removes its own surface chrome when embedded', () => {
    render(true)
    const card = container.querySelector('[data-slot="card"]')

    expect(card?.className).toContain('ring-0')
    expect(card?.className).toContain('bg-transparent')
  })
})
