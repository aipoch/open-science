// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InlineParentMessageProjection } from './subagent-release-projection'
import { WorkspaceSubagentMessageRow } from './WorkspaceSubagentMessageRow'

const createMessage = (
  overrides: Partial<InlineParentMessageProjection> = {}
): InlineParentMessageProjection => ({
  messageId: 'message-1',
  sourceFrameId: 'child-frame',
  sourceName: 'Evidence mapper',
  kind: 'question',
  text: 'Should I include the preprint evidence?',
  queuedAt: 100,
  ...overrides
})

describe('WorkspaceSubagentMessageRow', () => {
  let notifyResize: (() => void) | undefined
  const originalResizeObserver = globalThis.ResizeObserver

  beforeEach(() => {
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void {
        notifyResize = () => this.callback([], this as unknown as ResizeObserver)
      }
      disconnect(): void {
        notifyResize = undefined
      }
      unobserve(): void {
        notifyResize = undefined
      }
    }
  })

  afterEach(() => {
    cleanup()
    notifyResize = undefined
    if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver
    else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
  })

  it('shows a question, its full body, and a keyboard-accessible source preview action', () => {
    const onOpenSource = vi.fn()
    render(<WorkspaceSubagentMessageRow message={createMessage()} onOpenSource={onOpenSource} />)

    expect(screen.getByRole('article').getAttribute('aria-label')).toBe(
      'Evidence mapper asked a question.'
    )
    expect(screen.getByRole('heading').textContent).toBe('Evidence mapper asked a question')
    expect(screen.getByText('Should I include the preprint evidence?')).toBeTruthy()
    expect(screen.getByText('View agent')).toBeTruthy()

    const source = screen.getByRole('button', {
      name: 'Open Subagent preview for Evidence mapper'
    })
    source.focus()
    expect(source.tabIndex).toBe(0)
    fireEvent.click(source)
    expect(onOpenSource).toHaveBeenCalledTimes(1)
  })

  it('clamps an overflowing body to six lines and expands or collapses it on demand', () => {
    render(
      <WorkspaceSubagentMessageRow
        message={createMessage({ text: 'A long message\n'.repeat(12) })}
        onOpenSource={() => undefined}
      />
    )

    const body = screen.getByTestId('subagent-message-body')
    Object.defineProperties(body, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 240 }
    })
    act(() => notifyResize?.())

    const toggle = screen.getByRole('button', { name: 'Show more' })
    expect(body.className).toContain('line-clamp-6')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe(body.id)

    fireEvent.click(toggle)
    expect(body.className).not.toContain('line-clamp-6')
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(body.className).toContain('line-clamp-6')
  })

  it('does not add an expand control when the body fits in the preview', () => {
    render(<WorkspaceSubagentMessageRow message={createMessage()} onOpenSource={() => undefined} />)

    const body = screen.getByTestId('subagent-message-body')
    Object.defineProperties(body, {
      clientHeight: { configurable: true, value: 20 },
      scrollHeight: { configurable: true, value: 20 }
    })
    act(() => notifyResize?.())

    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    expect(body.className).not.toContain('line-clamp-6')
  })

  it('distinguishes an informational message without adding delivery status UI', () => {
    render(
      <WorkspaceSubagentMessageRow
        message={createMessage({ kind: 'info' })}
        onOpenSource={() => undefined}
      />
    )

    expect(screen.getByRole('heading').textContent).toBe('Evidence mapper sent a message')
    expect(screen.getByRole('article').getAttribute('aria-label')).toBe(
      'Evidence mapper sent a message.'
    )
    expect(screen.queryByText(/Queued|Accepted|Failed|Uncertain/u)).toBeNull()
  })
})
