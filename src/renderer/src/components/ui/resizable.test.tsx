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
})
