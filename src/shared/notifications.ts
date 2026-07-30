// The conversation a desktop-notification click should open. Main holds it (consume-once) until
// the renderer pulls it via 'notifications:take-pending-open-session' once its session store is
// hydrated — a push sent before the renderer's listener exists would be lost. Token uniquely
// identifies the click even when consecutive notifications target the same conversation.
export type OpenSessionFromNotificationRequest = {
  sessionId: string
  token: number
}

// Renderer-owned visibility evidence. Durable session existence comes from main's complete scan.
export type UnreadTaskViewState = {
  challengeId?: number
  visibleSessionId?: string
}
