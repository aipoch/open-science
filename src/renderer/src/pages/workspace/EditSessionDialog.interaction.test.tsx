// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import type { ChatSession } from '@/stores/session-store'
import { EditSessionDialog } from './EditSessionDialog'

vi.mock('react-i18next', () => createI18nTestStub())

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session: ChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Notebook review',
  description: 'Existing summary',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}

const Harness = ({ error }: { error?: string }): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const [titleDraft, setTitleDraft] = useState(session.title)
  const [descriptionDraft, setDescriptionDraft] = useState(session.description ?? '')

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Edit…
      </button>
      <EditSessionDialog
        session={open ? session : undefined}
        titleDraft={titleDraft}
        descriptionDraft={descriptionDraft}
        error={error}
        onTitleDraftChange={setTitleDraft}
        onDescriptionDraftChange={setDescriptionDraft}
        onCancel={() => setOpen(false)}
        onConfirmEdit={(event) => event.preventDefault()}
      />
    </>
  )
}

describe('EditSessionDialog interactions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('blocks saving an existing oversized title and explains how to correct it', () => {
    const title = `Attached ${'a'.repeat(100)}.csv`
    const render = (titleDraft: string): void => {
      act(() =>
        root.render(
          <EditSessionDialog
            session={{ ...session, title }}
            titleDraft={titleDraft}
            descriptionDraft="Updated description"
            onTitleDraftChange={() => undefined}
            onDescriptionDraftChange={() => undefined}
            onCancel={() => undefined}
            onConfirmEdit={(event) => event.preventDefault()}
          />
        )
      )
    }
    render(title)
    const input = document.querySelector<HTMLInputElement>('#edit-session-title')!
    expect(input.value).toHaveLength(113)
    expect(input.maxLength).toBe(80)
    expect
      .soft(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled)
      .toBe(true)
    expect.soft(document.querySelector('[role="alert"]')?.textContent ?? '').toMatch(/title.*80/i)
    render('Short title')
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it.each([
    ['title', 'x'.repeat(81), 'Summary', /title.*80/i],
    ['description', 'Title', 'x'.repeat(1001), /description.*1000/i]
  ])(
    'blocks form submission for an existing oversized %s',
    (_field, titleDraft, descriptionDraft, message) => {
      const confirm = vi.fn((event) => event.preventDefault())
      act(() =>
        root.render(
          <EditSessionDialog
            session={session}
            titleDraft={titleDraft as string}
            descriptionDraft={descriptionDraft as string}
            onTitleDraftChange={() => undefined}
            onDescriptionDraftChange={() => undefined}
            onCancel={() => undefined}
            onConfirmEdit={confirm}
          />
        )
      )
      act(() =>
        document
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      )
      expect(confirm).not.toHaveBeenCalled()
      expect(document.querySelector('[role="alert"]')?.textContent ?? '').toMatch(message as RegExp)
      expect(
        document.querySelector('[aria-invalid="true"]')?.getAttribute('aria-describedby')
      ).toBe('edit-session-error')
    }
  )

  it('opens from the Session action without entering a render loop', () => {
    act(() => root.render(<Harness />))

    const editButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Edit…'
    )
    expect(editButton).toBeDefined()

    act(() => editButton?.click())

    expect(document.querySelector('#edit-session-title')).toBeInstanceOf(HTMLInputElement)
    expect(document.querySelector('#edit-session-description')).toBeInstanceOf(HTMLTextAreaElement)
  })

  it('announces a save failure inside the open editor', () => {
    act(() => root.render(<Harness error="Could not save session details." />))

    const editButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Edit…'
    )
    act(() => editButton?.click())

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not save session details.'
    )
  })
})
