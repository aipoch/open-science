import { sanitizeMessageParts, type MessagePart } from '../../../../../shared/session-persistence'
import {
  docArtifactCount,
  docFromMessageParts,
  docSessionCount,
  docToText,
  MAX_COMPOSER_ARTIFACT_MENTIONS,
  MAX_COMPOSER_SESSION_MENTIONS,
  type ComposerDoc
} from './composer-doc'

const MESSAGE_ATTRIBUTE = 'data-open-science-message'

// Native clipboards may translate line endings (notably CRLF on Windows).
const normalizeClipboardText = (text: string): string => text.replace(/\r\n?/g, '\n').trim()

// HTML is the interoperable clipboard carrier; its markup is never inserted into the editor.
// The plain representation remains useful in other apps and when rich clipboard writes fail.
export const copyMessageToClipboard = async (
  text: string,
  parts: readonly MessagePart[] | undefined,
  projectId: string | undefined
): Promise<void> => {
  const clipboard = navigator.clipboard
  if (
    projectId &&
    parts?.some((part) => part.type !== 'text') &&
    normalizeClipboardText(docToText(docFromMessageParts([...parts]))) ===
      normalizeClipboardText(text) &&
    clipboard.write &&
    typeof ClipboardItem !== 'undefined'
  ) {
    const element = document.createElement('span')
    element.setAttribute(
      MESSAGE_ATTRIBUTE,
      JSON.stringify({ version: 1, origin: location.origin, projectId, parts })
    )
    element.textContent = text
    try {
      await clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([element.outerHTML], { type: 'text/html' })
        })
      ])
      return
    } catch {
      // Match other rich clipboard surfaces: retain a usable plain-text copy on unsupported hosts.
    }
  }
  await clipboard.writeText(text)
}

export const readMessageClipboard = (
  html: string,
  text: string,
  projectId: string | undefined
): ComposerDoc | undefined => {
  if (!projectId || !html || html.length > 1_000_000) return undefined
  try {
    // Template contents stay inert, including images, scripts, and event attributes.
    const template = document.createElement('template')
    template.innerHTML = html
    const elements = template.content.querySelectorAll(`[${MESSAGE_ATTRIBUTE}]`)
    if (elements.length !== 1) return undefined
    const parsed: unknown = JSON.parse(elements[0].getAttribute(MESSAGE_ATTRIBUTE) ?? '')
    if (!parsed || typeof parsed !== 'object') return undefined
    const candidate = parsed as {
      version?: unknown
      origin?: unknown
      projectId?: unknown
      parts?: unknown
    }
    if (
      candidate.version !== 1 ||
      candidate.origin !== location.origin ||
      candidate.projectId !== projectId ||
      !Array.isArray(candidate.parts)
    )
      return undefined
    const parts = sanitizeMessageParts(candidate.parts)
    if (parts.length !== candidate.parts.length) return undefined
    const doc = docFromMessageParts(parts)
    if (
      !parts.some((part) => part.type !== 'text') ||
      normalizeClipboardText(docToText(doc)) !== normalizeClipboardText(text)
    ) {
      return undefined
    }
    return doc
  } catch {
    return undefined
  }
}

// Apply the same caps as mention pickers to the draft remaining after selection replacement.
// Unavailable Skills and overflow references retain their readable label instead of disappearing.
export const constrainMessageClipboard = (
  fragment: ComposerDoc,
  remaining: ComposerDoc,
  allowedSkillIds: ReadonlySet<string>
): ComposerDoc => {
  let hasSkill = remaining.nodes.some((node) => node.type === 'skill')
  let artifacts = docArtifactCount(remaining)
  let sessions = docSessionCount(remaining)
  return {
    nodes: fragment.nodes.map((node) => {
      let allowed = true
      if (node.type === 'skill') {
        allowed = !hasSkill && allowedSkillIds.has(node.id)
        if (allowed) hasSkill = true
      } else if (node.type === 'session') {
        allowed = sessions < MAX_COMPOSER_SESSION_MENTIONS
        if (allowed) sessions++
      } else if (docArtifactCount({ nodes: [node] }) > 0) {
        allowed = artifacts < MAX_COMPOSER_ARTIFACT_MENTIONS
        if (allowed) artifacts++
      }
      return allowed ? node : { type: 'text', text: docToText({ nodes: [node] }) }
    })
  }
}
