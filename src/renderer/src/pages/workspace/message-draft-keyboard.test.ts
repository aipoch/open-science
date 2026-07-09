import { describe, expect, it, vi } from 'vitest'

import type { MessageDraftSubmitEvent } from './message-draft-keyboard'
import {
  shouldSubmitMessageDraftFromKeyDown,
  submitMessageDraftFromKeyDown
} from './message-draft-keyboard'

describe('message draft keyboard behavior', () => {
  it('submits plain Enter from the draft textarea', () => {
    expect(
      shouldSubmitMessageDraftFromKeyDown({
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { isComposing: false }
      })
    ).toBe(true)
  })

  it('keeps newline and composing Enter in the draft textarea', () => {
    expect(
      shouldSubmitMessageDraftFromKeyDown({
        key: 'Enter',
        shiftKey: true,
        nativeEvent: { isComposing: false }
      })
    ).toBe(false)
    expect(
      shouldSubmitMessageDraftFromKeyDown({
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { isComposing: true }
      })
    ).toBe(false)
    expect(
      shouldSubmitMessageDraftFromKeyDown({
        key: 'a',
        shiftKey: false,
        nativeEvent: { isComposing: false }
      })
    ).toBe(false)
  })
})

describe('message draft keyboard submit effects', () => {
  it('prevents textarea newline and submits the form for ready Enter drafts', () => {
    const event = createMessageDraftKeyDownEvent({ key: 'Enter' })

    expect(submitMessageDraftFromKeyDown(event, true)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.currentTarget.form?.requestSubmit).toHaveBeenCalledOnce()
  })

  it('does not submit when the draft cannot be sent', () => {
    const event = createMessageDraftKeyDownEvent({ key: 'Enter' })

    expect(submitMessageDraftFromKeyDown(event, false)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.currentTarget.form?.requestSubmit).not.toHaveBeenCalled()
  })

  it('keeps multiline and composing Enter events in the textarea', () => {
    const shiftEnterEvent = createMessageDraftKeyDownEvent({ key: 'Enter', shiftKey: true })
    const composingEnterEvent = createMessageDraftKeyDownEvent({
      key: 'Enter',
      isComposing: true
    })

    expect(submitMessageDraftFromKeyDown(shiftEnterEvent, true)).toBe(false)
    expect(submitMessageDraftFromKeyDown(composingEnterEvent, true)).toBe(false)
    expect(shiftEnterEvent.preventDefault).not.toHaveBeenCalled()
    expect(composingEnterEvent.preventDefault).not.toHaveBeenCalled()
    expect(shiftEnterEvent.currentTarget.form?.requestSubmit).not.toHaveBeenCalled()
    expect(composingEnterEvent.currentTarget.form?.requestSubmit).not.toHaveBeenCalled()
  })
})

type MessageDraftKeyDownEventStub = MessageDraftSubmitEvent & {
  preventDefault: () => void
  currentTarget: {
    form: {
      requestSubmit: () => void
    }
  }
}

const createMessageDraftKeyDownEvent = ({
  key,
  shiftKey = false,
  isComposing = false
}: {
  key: string
  shiftKey?: boolean
  isComposing?: boolean
}): MessageDraftKeyDownEventStub => ({
  key,
  shiftKey,
  nativeEvent: { isComposing },
  preventDefault: vi.fn(),
  currentTarget: {
    form: {
      requestSubmit: vi.fn()
    }
  }
})
