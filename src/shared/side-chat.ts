import type { PersistedConversationGraph } from './conversation-graph'
import { z } from 'zod'
import { defineApplicationCommandContract } from './application-command-contract'
import { isReasoningEffort, type ReasoningEffort } from './settings'
export type SideChatModelSelection = Readonly<{
  providerId: string
  model?: string
  reasoningEffort?: import('./settings').ReasoningEffort
}>

export type SideChatParentBranch = Readonly<{ frameId: string; branchId: string }>

export function sideChatParentBranch(
  graph: PersistedConversationGraph | undefined
): SideChatParentBranch | undefined {
  const frame = graph?.frames.find((item) => item.id === graph.activeFrameId)
  return frame ? { frameId: frame.id, branchId: frame.activeBranchId } : undefined
}

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
  // Whether saving the queued advisory or accepted delivery record is confirmed.
  // False with persistenceError means unconfirmed, not proof that the write rolled back.
  persisted: boolean
  persistenceError?: string
  systemHint: string
}>

export type SideChatStartRequest = Readonly<{
  expectedParentBranch?: SideChatParentBranch
  sideSessionId?: string
  parentSessionId: string
  projectId: string
  modelSelection?: SideChatModelSelection
  text: string
}>

export type SideChatStartResponse = Readonly<{
  sideSessionId: string
  frameworkId: import('./settings').AgentFrameworkId
  model?: string
}>

export type SideChatPromptRequest = Readonly<{
  expectedParentBranch?: SideChatParentBranch
  modelSelection?: SideChatModelSelection
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
  modelSelection?: SideChatModelSelection
  revision: number
  parentSessionId: string
  projectId: string
  sideSessionId?: string
  entries: readonly SideChatEntry[]
  running: boolean
  error?: string
  persistenceError?: string
  notice?: 'interrupted' | 'connection-ended'
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
  event:
    | import('./acp').AcpRuntimeEvent
    | SideChatLifecycleEvent
    | Readonly<{ kind: 'persistence'; error?: string }>
}>

export type SideChatRelayDeliveredEvent = Readonly<{
  parentSessionId: string
  projectId: string
  message: import('./session-persistence').PersistedChatMessage
}>

const identity = z.string().min(1)
const branchSchema = z.object({ frameId: identity, branchId: identity }).strict()
const modelSchema = z
  .object({
    providerId: identity,
    model: z.string().optional(),
    reasoningEffort: z.custom<ReasoningEffort>(isReasoningEffort).optional()
  })
  .strict()
const sessionSchema = z.object({ sideSessionId: identity }).strict()
const snapshotSchema = z
  .object({
    modelSelection: modelSchema.optional(),
    revision: z.number().int().nonnegative(),
    parentSessionId: identity,
    projectId: identity,
    sideSessionId: identity.optional(),
    entries: z.array(
      z.discriminatedUnion('kind', [
        z
          .object({
            id: identity,
            kind: z.literal('message'),
            role: z.enum(['user', 'assistant']),
            text: z.string()
          })
          .strict(),
        z
          .object({
            id: identity,
            kind: z.literal('tool'),
            title: z.string(),
            status: z.string().optional()
          })
          .strict()
      ])
    ),
    running: z.boolean(),
    error: z.string().optional(),
    persistenceError: z.string().optional(),
    notice: z.enum(['interrupted', 'connection-ended']).optional()
  })
  .strict()

export const sideChatCommandContracts = {
  list: defineApplicationCommandContract(
    z.tuple([]),
    z.object({ revision: z.number().int().nonnegative(), chats: z.array(snapshotSchema) }).strict()
  ),
  start: defineApplicationCommandContract(
    z.tuple([
      z
        .object({
          expectedParentBranch: branchSchema.optional(),
          sideSessionId: identity.optional(),
          parentSessionId: identity,
          projectId: identity,
          modelSelection: modelSchema.optional(),
          text: z.string()
        })
        .strict()
    ]),
    z
      .object({
        sideSessionId: identity,
        frameworkId: z.enum(['claude-code', 'opencode', 'codex', 'codebuddy']),
        model: z.string().optional()
      })
      .strict()
  ),
  send: defineApplicationCommandContract(
    z.tuple([
      z
        .object({
          expectedParentBranch: branchSchema.optional(),
          modelSelection: modelSchema.optional(),
          sideSessionId: identity,
          text: z.string()
        })
        .strict()
    ]),
    z.void()
  ),
  cancel: defineApplicationCommandContract(z.tuple([sessionSchema]), z.void()),
  close: defineApplicationCommandContract(
    z.tuple([z.union([sessionSchema, z.object({ parentSessionId: identity }).strict()])]),
    z.void()
  )
} as const
