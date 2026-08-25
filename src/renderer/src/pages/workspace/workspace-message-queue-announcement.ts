const MESSAGE_QUEUE_ANNOUNCEMENTS = {
  added: 'Message added to queue.',
  sent: 'Queued message sent.',
  movedUp: 'Queued message moved up.',
  movedDown: 'Queued message moved down.',
  reordered: 'Queued messages reordered.',
  removed: 'Queued message removed.',
  restoredForEdit: 'Queued message moved to the composer for editing.',
  interrupting: 'Stopping the current run before sending the queued message.',
  steering: 'Sending the queued message into the current run.',
  deferredUntilIdle: 'Queued message will send after the current run finishes.'
} as const

type MessageQueueAnnouncement =
  (typeof MESSAGE_QUEUE_ANNOUNCEMENTS)[keyof typeof MESSAGE_QUEUE_ANNOUNCEMENTS]

const queuedMessageMovedAnnouncement = (
  direction: 'up' | 'down'
): (typeof MESSAGE_QUEUE_ANNOUNCEMENTS)['movedUp' | 'movedDown'] =>
  direction === 'up' ? MESSAGE_QUEUE_ANNOUNCEMENTS.movedUp : MESSAGE_QUEUE_ANNOUNCEMENTS.movedDown

export { MESSAGE_QUEUE_ANNOUNCEMENTS, queuedMessageMovedAnnouncement }
export type { MessageQueueAnnouncement }
