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
