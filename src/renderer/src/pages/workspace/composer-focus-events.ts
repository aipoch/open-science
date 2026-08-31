// Cross-surface signal asking the conversation composer to take focus (same window-event pattern
// as notification-bell-events). Preview surfaces dispatch it after linking a PDF so the user can
// type immediately; ConversationPanel listens and bumps its ComposerEditor focus request.
export const FOCUS_COMPOSER_EVENT = 'open-science:focus-composer'

export const requestComposerFocus = (): void => {
  window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT))
}
