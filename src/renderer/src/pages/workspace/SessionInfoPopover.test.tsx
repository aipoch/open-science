// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@/stores/session-store'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import { SessionInfoPopover } from './SessionInfoPopover'
import { EditSessionDialog } from './EditSessionDialog'

vi.mock('react-i18next', () => createI18nTestStub())
afterEach(cleanup)

const session: ChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Review the evidence',
  description: 'Check the figures and summarize the findings.',
  number: 42,
  cwd: '/workspace',
  status: 'idle',
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  messages: [
    {
      id: 'user',
      role: 'user',
      status: 'complete',
      eventIds: [],
      content: 'Review',
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'agent',
      role: 'agent',
      status: 'complete',
      eventIds: [],
      content: 'Findings',
      createdAt: 2,
      updatedAt: 2
    },
    {
      id: 'control',
      role: 'user',
      status: 'complete',
      eventIds: [],
      content: 'Hidden',
      turnIntent: 'save-as-skill',
      createdAt: 3,
      updatedAt: 3
    }
  ],
  artifacts: [
    { id: 'figure', kind: 'workspace-file', path: 'figure.png' },
    { id: 'figure', kind: 'workspace-file', path: 'figure.png' },
    { id: 'table', kind: 'workspace-file', path: 'table.csv' }
  ]
}
const open = (): HTMLButtonElement => {
  const trigger = screen.getByRole<HTMLButtonElement>('button', {
    name: `Session information: ${session.title}`
  })
  fireEvent.click(trigger)
  return trigger
}
const value = (label: string): string | null =>
  screen.getByText(label).nextElementSibling?.textContent ?? null

describe('Session information', () => {
  it('counts the visible branch including Assistant messages and distinct Artifacts', () => {
    const { rerender } = render(<SessionInfoPopover session={session} onEdit={vi.fn()} />)
    open()
    expect(value('Messages in current branch')).toBe('21 from Assistant')
    expect(value('Artifacts')).toBe('2')
    expect(screen.getByRole('dialog').textContent).toContain('#42')
    expect(screen.getByRole('heading', { name: session.title }).className).toContain('truncate')
    expect(screen.getByText(session.description!).className).toContain('line-clamp-2')
    expect(document.querySelectorAll('time')[0].getAttribute('datetime')).toBe(
      new Date(session.createdAt).toISOString()
    )
    expect(document.querySelectorAll('time')[1].getAttribute('datetime')).toBe(
      new Date(session.updatedAt).toISOString()
    )
    // Switching the selected branch replaces its projection; no hidden history is added to the count.
    rerender(
      <SessionInfoPopover
        session={{ ...session, number: undefined, messages: [session.messages[0]], artifacts: [] }}
        onEdit={vi.fn()}
      />
    )
    expect(value('Messages in current branch')).toBe('10 from Assistant')
    expect(value('Artifacts')).toBe('0')
    expect(screen.getByRole('dialog').textContent).not.toContain('#42')
  })

  it('toggles the current Session and reflects the shared pinned state', () => {
    const toggle = vi.fn()
    const { rerender } = render(<SessionInfoPopover session={session} onTogglePin={toggle} />)
    open()
    const pin = screen.getByRole<HTMLButtonElement>('button', { name: 'Pin' })
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pin)
    expect(toggle).toHaveBeenCalledWith(session)
    const pinned = { ...session, pinned: true }
    rerender(<SessionInfoPopover session={pinned} onTogglePin={toggle} />)
    const unpin = screen.getByRole('button', { name: 'Unpin' })
    expect(unpin.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(unpin)
    expect(toggle).toHaveBeenLastCalledWith(pinned)
    rerender(<SessionInfoPopover session={session} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Pin' }).disabled).toBe(true)
  })

  it('shows honest loading values until hydration and disables editing', () => {
    const { rerender } = render(
      <SessionInfoPopover
        session={{ ...session, contentLoaded: false, messages: [], activeMessageCount: 99 }}
        onEdit={vi.fn()}
      />
    )
    open()
    expect(value('Messages in current branch')).toBe('—')
    expect(value('Artifacts')).toBe('—')
    expect(screen.getByRole('status').textContent).toContain('Loading')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit session' }).disabled).toBe(
      true
    )
    rerender(<SessionInfoPopover session={session} onEdit={vi.fn()} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(value('Messages in current branch')).toBe('21 from Assistant')
  })

  it('handles legacy empty details and a missing source without inventing a relationship', () => {
    const { rerender } = render(
      <SessionInfoPopover
        session={{ ...session, description: undefined, messages: [], artifacts: undefined }}
      />
    )
    open()
    expect(screen.queryByText('Source session')).toBeNull()
    expect(value('Messages in current branch')).toBe('00 from Assistant')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit session' }).disabled).toBe(
      true
    )
    rerender(
      <SessionInfoPopover session={{ ...session, branchSource: { sessionId: 'deleted-source' } }} />
    )
    expect(screen.getByText('deleted-source')).toBeTruthy()
    expect(screen.getByText('Source session unavailable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'deleted-source' })).toBeNull()
  })

  it('opens the recorded source through the existing navigation owner', () => {
    const navigate = vi.fn()
    render(
      <SessionInfoPopover
        session={{ ...session, branchSource: { sessionId: 'source' } }}
        sourceSession={{ id: 'source', title: 'Original research', number: 12 }}
        onOpenSession={navigate}
      />
    )
    open()
    fireEvent.click(screen.getByRole('button', { name: '#12 · Original research' }))
    expect(navigate).toHaveBeenCalledWith('source')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('dismisses with Escape and restores keyboard focus to its trigger', async () => {
    render(<SessionInfoPopover session={session} onEdit={vi.fn()} />)
    const trigger = open()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hands focus to the reused editor and restores the persistent header trigger on close', async () => {
    const Harness = (): React.JSX.Element => {
      const [editing, setEditing] = useState<ChatSession>()
      const returnFocus = useRef<HTMLElement | null>(null)
      return (
        <>
          <SessionInfoPopover
            session={session}
            onEdit={(selected) => {
              returnFocus.current = document.activeElement as HTMLElement
              setEditing(selected)
            }}
          />
          <EditSessionDialog
            session={editing}
            titleDraft={session.title}
            descriptionDraft={session.description!}
            onTitleDraftChange={vi.fn()}
            onDescriptionDraftChange={vi.fn()}
            onConfirmEdit={vi.fn()}
            onCancel={() => setEditing(undefined)}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              returnFocus.current?.focus()
            }}
          />
        </>
      )
    }
    render(<Harness />)
    const trigger = open()
    fireEvent.click(screen.getByRole('button', { name: 'Edit session' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Title' }))
    )
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
