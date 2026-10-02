// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSubagentCompletionRow } from './WorkspaceSubagentCompletionRow'

afterEach(cleanup)

describe('WorkspaceSubagentCompletionRow', () => {
  it.each([
    ['completed', 'Subagent Evidence audit completed'],
    ['error', 'Subagent Evidence audit failed'],
    ['cancelled', 'Subagent Evidence audit cancelled']
  ] as const)('distinguishes %s and links to the child preview', (status, label) => {
    const onOpenSource = vi.fn()
    render(
      <WorkspaceSubagentCompletionRow
        completion={{
          frameId: 'child',
          attemptId: 'attempt',
          promptMessageId: 'prompt',
          name: 'Evidence audit',
          status,
          endedAt: 100
        }}
        onOpenSource={onOpenSource}
      />
    )
    expect(screen.getByText(label)).toBeTruthy()
    const row = screen.getByTestId('subagent-completion')
    expect(row.getAttribute('data-frame-id')).toBe('child')
    expect(row.getAttribute('data-attempt-id')).toBe('attempt')
    fireEvent.click(
      screen.getByRole('button', { name: 'Open Subagent preview for Evidence audit' })
    )
    expect(onOpenSource).toHaveBeenCalledOnce()
  })

  it('uses a translated generic label when a historical child has no display name', () => {
    render(
      <WorkspaceSubagentCompletionRow
        completion={{
          frameId: 'child',
          attemptId: 'attempt',
          promptMessageId: 'prompt',
          status: 'completed',
          endedAt: 100
        }}
        onOpenSource={vi.fn()}
      />
    )
    expect(screen.getByText('Subagent completed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Subagent preview for Subagent' })).toBeTruthy()
  })
})
