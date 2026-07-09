type MessageDraftKeyDownState = {
  key: string
  shiftKey: boolean
  nativeEvent: {
    isComposing?: boolean
  }
}

type MessageDraftSubmitEvent = MessageDraftKeyDownState & {
  preventDefault: () => void
  currentTarget: {
    form?: {
      requestSubmit: () => void
    } | null
  }
}

// Defines the composer keyboard policy without depending on DOM rendering.
const shouldSubmitMessageDraftFromKeyDown = (event: MessageDraftKeyDownState): boolean =>
  event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing

// Executes the textarea submit side effects only after the shared keyboard policy passes.
const submitMessageDraftFromKeyDown = (
  event: MessageDraftSubmitEvent,
  canSendMessage: boolean
): boolean => {
  if (!canSendMessage || !shouldSubmitMessageDraftFromKeyDown(event)) return false

  event.preventDefault()
  event.currentTarget.form?.requestSubmit()

  return true
}

export { shouldSubmitMessageDraftFromKeyDown, submitMessageDraftFromKeyDown }
export type { MessageDraftKeyDownState, MessageDraftSubmitEvent }
