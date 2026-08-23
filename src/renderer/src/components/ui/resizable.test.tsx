import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type * as React from 'react'

vi.mock('react-resizable-panels', () => ({
  Separator: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element => (
    <div {...props}>{children}</div>
  )
}))

const { ResizableHandle } = await import('./resizable')

describe('ResizableHandle', () => {
  it('applies hover, keyboard-focus, and active indicator states to the separator', () => {
    const markup = renderToStaticMarkup(<ResizableHandle aria-label="Resize panel" />)
    const classNames = markup.match(/class="([^"]*)"/)?.[1]?.split(' ') ?? []

    expect(classNames).toEqual(
      expect.arrayContaining([
        'hover:before:opacity-60',
        'focus-visible:before:opacity-60',
        'data-[separator=active]:before:opacity-60',
        'after:w-3',
        'before:h-8',
        'before:w-0.5',
        'before:opacity-0'
      ])
    )
  })

  it('includes horizontal-separator geometry for vertical panel groups', () => {
    const markup = renderToStaticMarkup(<ResizableHandle aria-label="Resize stacked panels" />)
    const classNames = markup.match(/class="([^"]*)"/)?.[1]?.split(' ') ?? []

    expect(classNames).toEqual(
      expect.arrayContaining([
        'aria-[orientation=horizontal]:h-px',
        'aria-[orientation=horizontal]:w-full',
        'aria-[orientation=horizontal]:after:h-3',
        'aria-[orientation=horizontal]:before:h-0.5',
        'aria-[orientation=horizontal]:before:w-8'
      ])
    )
  })

  it('renders optional separator content', () => {
    const markup = renderToStaticMarkup(
      <ResizableHandle aria-label="Resize stacked panels">
        <span>Notebook terminal</span>
      </ResizableHandle>
    )

    expect(markup).toContain('<span>Notebook terminal</span>')
  })
})
