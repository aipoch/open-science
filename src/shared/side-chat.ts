export const SIDE_CHAT_MESSAGE_LIMIT = 12_000

export type SideChatTargetState = 'running' | 'waiting' | 'idle' | 'completed'

export type SideChatSendMessageRequest = Readonly<{
  target: 'main'
  text: string
}>

export type SideChatSendMessageResult = Readonly<{
  status: 'queued' | 'injected'
  messageId: string
  targetState: SideChatTargetState
  delivery: 'next-user-turn' | 'current-turn'
  persisted: true
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

export type SideChatCloseRequest = SideChatSessionRequest | Readonly<{ parentSessionId: string }>

export type SideChatEntry =
  | Readonly<{ id: string; kind: 'message'; role: 'user' | 'assistant'; text: string }>
  | Readonly<{ id: string; kind: 'tool'; title: string; status?: string }>

export type SideChatSnapshot = Readonly<{
  revision: number
  parentSessionId: string
  projectId: string
  sideSessionId?: string
  entries: readonly SideChatEntry[]
  running: boolean
  error?: string
}>

export type SideChatSnapshotList = Readonly<{
  revision: number
  chats: readonly SideChatSnapshot[]
}>

export type SideChatLifecycleEvent = Readonly<{
  kind: 'closed'
  reason: 'closed' | 'connection-error' | 'connection-closed'
}>

export type SideChatRuntimeEvent = Readonly<{
  revision: number
  parentSessionId: string
  projectId: string
  sideSessionId: string
  event: import('./acp').AcpRuntimeEvent | SideChatLifecycleEvent
}>

export type SideChatRelayDeliveredEvent = Readonly<{
  parentSessionId: string
  projectId: string
  message: import('./session-persistence').PersistedChatMessage
}>
