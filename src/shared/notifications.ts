// The conversation a desktop-notification click should open. Main holds it (consume-once) until
// the renderer pulls it via 'notifications:take-pending-open-session' once its session store is
// hydrated — a push sent before the renderer's listener exists would be lost.
export type OpenSessionFromNotificationRequest = {
  sessionId: string
}
