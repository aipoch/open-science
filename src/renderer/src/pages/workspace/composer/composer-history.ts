import type { MessagePart } from '../../../../../shared/session-persistence'
import type { ChatMessage, ChatSession } from '@/stores/session-store'

import {
  docFromMessageParts,
  docFromText,
  docIsEmpty,
  docToText,
  type ComposerDoc,
  type ComposerNode
} from './composer-doc'

export type ComposerHistoryEntry = {
  id: string
  messageId: string
  doc: ComposerDoc
}

type HistoryMessage = Pick<ChatMessage, 'id' | 'role' | 'content' | 'parts' | 'uploads'>
type HistorySession = Pick<ChatSession, 'id' | 'messages' | 'isPending' | 'createdAt' | 'updatedAt'>

const docFromHistoryMessage = (message: HistoryMessage): ComposerDoc => {
  if (!message.parts) return docFromText(message.content)
  const structured = docFromMessageParts(message.parts as MessagePart[])
  return docToText(structured).trim() === message.content
    ? structured
    : docFromText(message.content)
}

const entryFromMessage = (
  sessionId: string,
  message: HistoryMessage
): ComposerHistoryEntry | null => {
  if (message.role !== 'user' || (message.uploads?.length ?? 0) > 0) return null
  const doc = docFromHistoryMessage(message)
  if (docIsEmpty(doc)) return null
  return { id: `${sessionId}:${message.id}`, messageId: message.id, doc }
}

// Current-session history is newest-first so the first ArrowUp restores the latest visible prompt.
export const buildSessionComposerHistory = (
  session: Pick<ChatSession, 'id' | 'messages'>
): ComposerHistoryEntry[] =>
  session.messages
    .map((message) => entryFromMessage(session.id, message))
    .filter((entry): entry is ComposerHistoryEntry => entry !== null)
    .reverse()

// A new conversation recalls one visible opener per durable session, ordered by recent activity.
export const buildStarterComposerHistory = (
  sessions: readonly HistorySession[]
): ComposerHistoryEntry[] => {
  const seenMessageIds = new Set<string>()
  const entries: ComposerHistoryEntry[] = []

  for (const session of [...sessions].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      left.id.localeCompare(right.id)
  )) {
    if (session.isPending) continue
    const opener = session.messages.find((message) => message.role === 'user')
    if (!opener || seenMessageIds.has(opener.id)) continue
    const entry = entryFromMessage(session.id, opener)
    if (!entry) continue
    seenMessageIds.add(opener.id)
    entries.push(entry)
  }

  return entries
}

const pushNode = (nodes: ComposerNode[], node: ComposerNode): void => {
  const previous = nodes.at(-1)
  if (node.type === 'text' && previous?.type === 'text') previous.text += node.text
  else nodes.push(node.type === 'text' ? { ...node } : node)
}

// Invalid historical Skill chips remain readable without pretending they can still execute.
export const normalizeHistorySkills = (
  doc: ComposerDoc,
  catalogSkillIds: ReadonlySet<string>,
  allowedSkillIds?: ReadonlySet<string>
): { doc: ComposerDoc; unavailableSkillNames: string[] } => {
  const nodes: ComposerNode[] = []
  const unavailableSkillNames: string[] = []

  for (const node of doc.nodes) {
    if (
      node.type === 'skill' &&
      (!catalogSkillIds.has(node.id) || (allowedSkillIds && !allowedSkillIds.has(node.id)))
    ) {
      pushNode(nodes, { type: 'text', text: `/${node.name}` })
      if (!unavailableSkillNames.includes(node.name)) unavailableSkillNames.push(node.name)
    } else {
      pushNode(nodes, node)
    }
  }

  return { doc: { nodes }, unavailableSkillNames }
}
