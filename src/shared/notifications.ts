// Payload sent to the renderer when the user clicks a desktop notification: bring the app to the
// front and open the conversation the finished/failed task belongs to.
export type OpenSessionFromNotificationRequest = {
  sessionId: string
}
