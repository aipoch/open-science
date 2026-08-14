// @vitest-environment jsdom
// Integration with the real Streamdown: pins the BlockProps/components contract that
// StreamingBlock relies on (per-block `isIncomplete`, merged default `components.code`).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { code } from '@streamdown/code'
import { Streamdown } from 'streamdown'

import { StreamingBlock } from './StreamingBlock'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STREAMING_CONTENT = 'Before\n\n```js\nconst done = 1\n```\n\n```py\nprint("partial'
const CLOSED_CONTENT = `${STREAMING_CONTENT}")\n\`\`\``

describe('StreamingBlock with real Streamdown', () => {
  let container: HTMLDivElement
  let root: Root

  const renderStreamdown = async (content: string, isAnimating: boolean): Promise<void> => {
    await act(async () => {
      root.render(
        <Streamdown
          mode={isAnimating ? 'streaming' : 'static'}
          isAnimating={isAnimating}
          parseIncompleteMarkdown={isAnimating}
          plugins={{ code }}
          controls={false}
          BlockComponent={StreamingBlock}
        >
          {content}
        </Streamdown>
      )
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
  })

  it('renders the trailing unclosed fence as plain text while closed fences keep highlighting', async () => {
    await renderStreamdown(STREAMING_CONTENT, true)

    const blocks = container.querySelectorAll('[data-streamdown="code-block"]')
    expect(blocks).toHaveLength(2)

    // The closed js block renders through Streamdown's own CodeBlock (plain-text fallback
    // while Shiki loads, then highlighted tokens) — never our streaming stand-in.
    expect(blocks[0].querySelector('pre.font-mono')).toBeNull()

    // The trailing unclosed py block is our plain stand-in: no Shiki token spans.
    const trailing = blocks[1]
    expect(trailing.getAttribute('data-incomplete')).toBe('true')
    const plainPre = trailing.querySelector('pre.font-mono')
    expect(plainPre?.textContent).toBe('print("partial\n')
    expect(trailing.querySelectorAll('span[data-streamdown], pre span[style]').length).toBe(0)
  })

  it('restores the default highlighted code block once the fence closes', async () => {
    await renderStreamdown(STREAMING_CONTENT, true)
    expect(container.querySelectorAll('pre.font-mono')).toHaveLength(1)

    await renderStreamdown(CLOSED_CONTENT, false)

    // The trailing block renders through Streamdown's CodeBlock again (plain-token Suspense
    // fallback until Shiki resolves), so the streaming stand-in is gone.
    expect(container.querySelectorAll('pre.font-mono')).toHaveLength(0)
    const bodies = container.querySelectorAll('[data-streamdown="code-block-body"]')
    expect(bodies).toHaveLength(2)
    expect(bodies[1].textContent).toContain('print("partial")')
  })
})
