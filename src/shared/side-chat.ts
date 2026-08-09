export const SIDE_CHAT_MESSAGE_LIMIT = 12_000

export type SideChatTargetState = 'running' | 'waiting' | 'idle' | 'completed'

export type SideChatSendMessageRequest = Readonly<{
  target: 'main'
  text: string
}>

export type SideChatSendMessageResult = Readonly<{
  status: 'queued'
  messageId: string
  targetState: SideChatTargetState
  delivery: 'next-user-turn'
  persisted: false
  systemHint: string
}>

export type SideChatStartRequest = Readonly<{
  parentSessionId: string
  projectId: string
  text: string
}>

export type SideChatStartResponse = Readonly<{
  sideSessionId: string
  frameworkId: import('./settings').AgentFrameworkId
  model?: string
}>

export type SideChatPromptRequest = Readonly<{
  sideSessionId: string
  text: string
}>

export type SideChatSessionRequest = Readonly<{
  sideSessionId: string
}>

export type SideChatCloseRequest =
  SideChatSessionRequest | Readonly<{ parentSessionId: string; discardRelays: boolean }>

export type SideChatLifecycleEvent = Readonly<{
  kind: 'closed'
  reason: 'connection-error' | 'connection-closed'
}>

export type SideChatRuntimeEvent = Readonly<{
  parentSessionId: string
  sideSessionId: string
  event: import('./acp').AcpRuntimeEvent | SideChatLifecycleEvent
}>

export type SideChatRelayDeliveredEvent = Readonly<{
  parentSessionId: string
  projectId: string
  message: import('./session-persistence').PersistedChatMessage
}>
