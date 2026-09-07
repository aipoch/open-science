import { Lexer, Marked, Renderer, Tokenizer, type Token } from 'marked'

import {
  isHiddenControlMessage,
  isHumanUserMessage,
  type PersistedArtifact,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedMessageImage
} from './session-persistence'

export type ConversationExportFormat = 'markdown' | 'pdf'

export type ExportConversationRequest = {
  projectId: string
  sessionId: string
  format: ConversationExportFormat
  selectedPromptMessageIds?: string[]
  // Preview-based callers bind the export to the content the user reviewed.
  expectedContentHash?: string
}

export type ExportConversationResult = {
  saved: boolean
  filePath?: string
}

export type ConversationExportAttachment = {
  name: string
  mimeType?: string
}

export type ConversationExportImage = Pick<PersistedMessageImage, 'mimeType' | 'data'>

export type ConversationExportMessage = {
  role: 'user' | 'assistant'
  createdAt: number
  markdown: string
  attachments: ConversationExportAttachment[]
  images: ConversationExportImage[]
}

export type ConversationExportDocument = {
  version: 1
  title: string
  createdAt: number
  updatedAt: number
  exportedAt: number
  messages: ConversationExportMessage[]
}

export type ConversationExportTurn = {
  promptMessageId: string
  prompt: PersistedChatMessage
  messages: PersistedChatMessage[]
}

const THINK_BLOCK_PATTERN = /^<think\b[^>]*>/i
const UNSAFE_FILENAME_CHARACTERS = /[<>:"/\\|?*]+/g
const RENDERER_AUTO_TITLE_PREFIX_LENGTH = 48
const HEADLESS_AUTO_TITLE_MAX_LENGTH = 60
const HEADLESS_AUTO_TITLE_PREFIX_LENGTH = 57
const EXPORT_FILENAME_MAX_BYTES = 240

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const normalizeInlineText = (value: string): string => value.replace(/\s+/g, ' ').trim()

const isKnownTruncatedAutoTitle = (title: string, content: string): boolean => {
  const normalizedTitle = normalizeInlineText(content)

  return (
    (normalizedTitle.length > RENDERER_AUTO_TITLE_PREFIX_LENGTH &&
      title === `${normalizedTitle.slice(0, RENDERER_AUTO_TITLE_PREFIX_LENGTH)}...`) ||
    (normalizedTitle.length > HEADLESS_AUTO_TITLE_MAX_LENGTH &&
      title === `${normalizedTitle.slice(0, HEADLESS_AUTO_TITLE_PREFIX_LENGTH)}...`)
  )
}

const deriveTitleFromPrompt = (content: string): string => {
  const normalizedPrompt = normalizeInlineText(content).replace(/^#{1,6}\s+/, '')

  return normalizedPrompt.trim()
}

const resolveConversationExportTitle = (
  session: PersistedChatSession,
  messages: readonly PersistedChatMessage[]
): string => {
  const storedTitle = normalizeInlineText(session.title)
  const firstUserMessage = messages.find((message) => message.role === 'user')
  const prompt = firstUserMessage?.content ?? ''

  if (prompt && isKnownTruncatedAutoTitle(storedTitle, prompt)) {
    return deriveTitleFromPrompt(prompt) || storedTitle
  }

  return storedTitle || deriveTitleFromPrompt(prompt) || 'Untitled conversation'
}

const removeControlCharacters = (value: string): string =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')

const escapeMarkdownInline = (value: string): string =>
  normalizeInlineText(value).replace(/([\\`*_[\]<>])/g, '\\$1')

const toIsoDate = (timestamp: number): string => new Date(timestamp).toISOString()

const getPathBaseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''

const getAttachmentDisplayName = (...candidates: Array<string | undefined>): string => {
  for (const candidate of candidates) {
    const name = getPathBaseName(normalizeInlineText(candidate ?? ''))
    if (name) return name
  }
  return ''
}

const getArtifactAttachment = (
  artifact: PersistedArtifact | undefined
): ConversationExportAttachment | undefined => {
  if (!artifact) return undefined
  const name = getAttachmentDisplayName(artifact.name, artifact.path)
  if (!name) return undefined

  return {
    name,
    ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {})
  }
}

const getMessageAttachments = (
  message: PersistedChatMessage,
  artifactsById: ReadonlyMap<string, PersistedArtifact>
): ConversationExportAttachment[] => {
  const attachments: ConversationExportAttachment[] = []

  for (const upload of message.uploads ?? []) {
    const name = getAttachmentDisplayName(upload.originalName, upload.name)
    if (!name) continue
    attachments.push({
      name,
      ...(upload.mimeType ? { mimeType: upload.mimeType } : {})
    })
  }

  for (const artifactId of message.artifactIds ?? []) {
    const attachment = getArtifactAttachment(artifactsById.get(artifactId))
    if (attachment) attachments.push(attachment)
  }

  for (const [index, image] of (message.images ?? []).entries()) {
    attachments.push({
      name: `Image ${index + 1}`,
      mimeType: image.mimeType
    })
  }

  return attachments
}

// Markdown containers remove quote/list prefixes before tokenizing their children. Map each
// de-prefixed line back to its original line so code ranges preserve the source byte-for-byte.
const exportCodeRanges = (content: string): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = []
  const mapLines = (text: string, raw: string, positions: number[]): number[] => {
    const lines = raw.split('\n')
    let rawOffset = 0
    const textLines = text.split('\n')
    return textLines.flatMap((line, index) => {
      const original = lines[index] ?? ''
      const column = original.lastIndexOf(line)
      const mapped = Array.from(
        { length: line.length },
        (_, i) => positions[rawOffset + Math.max(column, 0) + i]
      )
      if (index < textLines.length - 1) mapped.push(positions[rawOffset + original.length])
      rawOffset += original.length + 1
      return mapped
    })
  }
  const visit = (tokens: Token[], positions: number[]): void => {
    let offset = 0
    for (const token of tokens) {
      const mapped = positions.slice(offset, offset + token.raw.length)
      if (token.type === 'code' && mapped.length) {
        ranges.push({ start: mapped[0], end: mapped[mapped.length - 1] + 1 })
      } else if (token.type === 'blockquote') {
        visit(token.tokens ?? [], mapLines(token.text, token.raw, mapped))
      } else if (token.type === 'list') {
        let itemOffset = 0
        for (const item of token.items) {
          const itemPositions = mapped.slice(itemOffset, itemOffset + item.raw.length)
          visit(item.tokens, mapLines(item.text, item.raw, itemPositions))
          itemOffset += item.raw.length
        }
      }
      offset += token.raw.length
    }
  }
  const positions: number[] = []
  const normalized = content.replace(/\r\n|\r|[^\r]/g, (character, offset: number) => {
    positions.push(offset)
    return character.startsWith('\r') ? '\n' : character
  })
  visit(Lexer.lex(normalized), positions)
  return ranges
}

// Reuse Markdown's code/escape tokenizers so literal tags cannot open a reasoning block.
// Consume a real reasoning block in one step, including any code inside that private block.
export const sanitizeExportMarkdown = (content: string): string => {
  const tokenizer = new Tokenizer()
  new Lexer({ tokenizer }) // Initializes the tokenizer's Markdown grammar.
  const codeRanges = exportCodeRanges(content)
  let rangeIndex = 0
  const parts: { raw: string; code: boolean }[] = []
  let offset = 0
  while (offset < content.length) {
    while (codeRanges[rangeIndex]?.end <= offset) rangeIndex += 1
    const range = codeRanges[rangeIndex]
    if (range && offset >= range.start) {
      parts.push({ raw: content.slice(offset, range.end), code: true })
      offset = range.end
      continue
    }
    const remaining = content.slice(offset, range?.start)
    const lineStart = offset === 0 || content[offset - 1] === '\n'
    const code =
      (lineStart && (tokenizer.fences(remaining) ?? tokenizer.code(remaining))) ||
      tokenizer.codespan(remaining)
    if (code) {
      parts.push({ raw: code.raw, code: true })
      offset += code.raw.length
      continue
    }
    const thought = THINK_BLOCK_PATTERN.exec(content.slice(offset))
    if (thought) {
      // A closing tag inside a fenced example belongs to the example, not the outer block.
      const closing = /<\/think\s*>/gi
      closing.lastIndex = offset + thought[0].length
      let end: RegExpExecArray | null
      do {
        end = closing.exec(content)
      } while (end && codeRanges.some((code) => end!.index >= code.start && end!.index < code.end))
      offset = end ? closing.lastIndex : content.length
      continue
    }
    const raw =
      tokenizer.escape(remaining)?.raw ?? /^[^`<\\\n]+/.exec(remaining)?.[0] ?? remaining[0]
    const last = parts.at(-1)
    if (last && !last.code) last.raw += raw
    else parts.push({ raw, code: false })
    offset += raw.length
  }
  if (parts[0] && !parts[0].code) parts[0].raw = parts[0].raw.trimStart()
  const last = parts.at(-1)
  if (last && !last.code) last.raw = last.raw.trimEnd()
  return parts.map((part) => part.raw).join('')
}

// A precondition only: Main still renders its own durable Session, never renderer-supplied data.
export const hashConversationExportContent = async (
  session: PersistedChatSession
): Promise<string> => {
  const bytes = new TextEncoder().encode(
    JSON.stringify(createConversationExportDocument(session, 0))
  )
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const sanitizeExportFilename = (title: string): string => {
  const sanitized = removeControlCharacters(title)
    .replace(UNSAFE_FILENAME_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()

  if (!sanitized) return 'conversation'

  const byteLength = (character: string): number => {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) return 1
    if (codePoint <= 0x7ff) return 2
    if (codePoint <= 0xffff) return 3
    return 4
  }

  const characters = Array.from(sanitized)
  const totalBytes = characters.reduce((sum, character) => sum + byteLength(character), 0)
  if (totalBytes <= EXPORT_FILENAME_MAX_BYTES) return sanitized

  const suffix = '...'
  const contentByteLimit = EXPORT_FILENAME_MAX_BYTES - suffix.length
  let truncated = ''
  let truncatedBytes = 0

  for (const character of characters) {
    const characterBytes = byteLength(character)
    if (truncatedBytes + characterBytes > contentByteLimit) break
    truncated += character
    truncatedBytes += characterBytes
  }

  return `${truncated.trimEnd()}${suffix}`
}

export const createConversationExportTurns = (
  messages: readonly PersistedChatMessage[]
): ConversationExportTurn[] => {
  const visibleMessages = messages.filter((message) => !isHiddenControlMessage(message))
  const promptIndexes = visibleMessages.flatMap((message, index) =>
    isHumanUserMessage(message) ? [index] : []
  )

  return promptIndexes.map((startIndex, turnIndex) => {
    const prompt = visibleMessages[startIndex]
    const endIndex = promptIndexes[turnIndex + 1] ?? visibleMessages.length

    return {
      promptMessageId: prompt.id,
      prompt,
      messages: visibleMessages.slice(startIndex, endIndex)
    }
  })
}

export const selectConversationExportMessages = (
  messages: readonly PersistedChatMessage[],
  selectedPromptMessageIds?: readonly string[]
): PersistedChatMessage[] => {
  const visibleMessages = messages.filter((message) => !isHiddenControlMessage(message))
  if (selectedPromptMessageIds === undefined) return visibleMessages

  const selectedIds = new Set(selectedPromptMessageIds)
  if (selectedIds.size === 0 || selectedIds.size !== selectedPromptMessageIds.length) {
    throw new Error('Invalid selected conversation turns.')
  }

  const turns = createConversationExportTurns(messages)
  const availablePromptIds = new Set(turns.map((turn) => turn.promptMessageId))
  if (
    selectedPromptMessageIds.some((promptMessageId) => !availablePromptIds.has(promptMessageId))
  ) {
    throw new Error('Selected conversation turns are no longer available.')
  }

  return turns
    .filter((turn) => selectedIds.has(turn.promptMessageId))
    .flatMap((turn) => turn.messages)
}

// Projects only the active-branch message view. Internal ids, runtime metadata, paths and tool
// payloads never enter this stable export contract.
export const createConversationExportDocument = (
  session: PersistedChatSession,
  exportedAt: number,
  selectedPromptMessageIds?: readonly string[]
): ConversationExportDocument => {
  const artifactsById = new Map(
    (session.artifacts ?? []).map((artifact) => [artifact.id, artifact])
  )
  const visibleMessages = session.messages.filter((message) => !isHiddenControlMessage(message))
  const messages = selectConversationExportMessages(session.messages, selectedPromptMessageIds)

  return {
    version: 1,
    title: resolveConversationExportTitle(session, visibleMessages),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    exportedAt,
    messages: messages.map((message) => ({
      role: message.role === 'agent' ? 'assistant' : 'user',
      createdAt: message.createdAt,
      markdown:
        message.role === 'agent' ? sanitizeExportMarkdown(message.content) : message.content,
      attachments: getMessageAttachments(message, artifactsById),
      images: (message.images ?? []).map(({ mimeType, data }) => ({ mimeType, data }))
    }))
  }
}

const renderAttachmentListMarkdown = (attachments: ConversationExportAttachment[]): string => {
  if (attachments.length === 0) return ''

  return [
    '**Attachments**',
    '',
    ...attachments.map(
      (attachment) =>
        `- ${escapeMarkdownInline(attachment.name)}${
          attachment.mimeType ? ` (${escapeMarkdownInline(attachment.mimeType)})` : ''
        }`
    ),
    ''
  ].join('\n')
}

export const renderConversationMarkdown = (document: ConversationExportDocument): string => {
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(document.title)}`,
    `created: ${JSON.stringify(toIsoDate(document.createdAt))}`,
    `updated: ${JSON.stringify(toIsoDate(document.updatedAt))}`,
    `exported: ${JSON.stringify(toIsoDate(document.exportedAt))}`,
    '---'
  ].join('\n')
  const messages = document.messages.map((message) => {
    const role = message.role === 'assistant' ? 'Assistant' : 'User'
    const content = message.markdown || '_No visible message content._'
    const attachments = renderAttachmentListMarkdown(message.attachments)

    return [`## ${role}`, '', `_${toIsoDate(message.createdAt)}_`, '', content, '', attachments]
      .filter((part, index, parts) => part !== '' || parts[index - 1] !== '')
      .join('\n')
      .trim()
  })

  return [
    frontmatter,
    '',
    `# ${escapeMarkdownInline(document.title)}`,
    '',
    ...messages.flatMap((message, index) => [...(index > 0 ? ['---', ''] : []), message, ''])
  ]
    .join('\n')
    .trimEnd()
    .concat('\n')
}

const safeLinkHref = (href: string): string | undefined => {
  try {
    const url = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : undefined
  } catch {
    return undefined
  }
}

const markdownRenderer = new Renderer()
markdownRenderer.html = ({ text }) => escapeHtml(text)
markdownRenderer.image = ({ text }) =>
  `<span class="image-placeholder">[Image: ${escapeHtml(text || 'image')}]</span>`
markdownRenderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens)
  const safeHref = safeLinkHref(href)
  if (!safeHref) return text

  return `<a href="${escapeHtml(safeHref)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</a>`
}

const markdownParser = new Marked({
  async: false,
  gfm: true,
  renderer: markdownRenderer
})

const renderMarkdownHtml = (markdown: string): string => {
  if (!markdown) return '<p class="empty-message">No visible message content.</p>'
  const rendered = markdownParser.parse(markdown)
  if (typeof rendered !== 'string') throw new Error('Markdown export renderer became asynchronous.')
  return rendered
}

const renderAttachmentListHtml = (attachments: ConversationExportAttachment[]): string => {
  if (attachments.length === 0) return ''

  return `<section class="attachments"><h3>Attachments</h3><ul>${attachments
    .map(
      (attachment) =>
        `<li>${escapeHtml(attachment.name)}${
          attachment.mimeType ? ` <span>(${escapeHtml(attachment.mimeType)})</span>` : ''
        }</li>`
    )
    .join('')}</ul></section>`
}

const renderMessageImagesHtml = (images: ConversationExportImage[]): string => {
  if (images.length === 0) return ''

  return `<section class="message-images" aria-label="Message images">${images
    .map(
      (image, index) =>
        `<figure><img src="data:${image.mimeType};base64,${image.data}" alt="Conversation image ${index + 1}"></figure>`
    )
    .join('')}</section>`
}

export const renderConversationHtml = (document: ConversationExportDocument): string => {
  const messages = document.messages
    .map((message) => {
      const role = message.role === 'assistant' ? 'Assistant' : 'User'
      return `<article class="message message-${message.role}">
  <header><h2>${role}</h2><time>${escapeHtml(toIsoDate(message.createdAt))}</time></header>
  <div class="message-content">${renderMarkdownHtml(message.markdown)}</div>
  ${renderMessageImagesHtml(message.images)}
  ${renderAttachmentListHtml(message.attachments)}
</article>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <title>${escapeHtml(document.title)}</title>
  <style>
    @page { size: A4; margin: 16mm 15mm 18mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #1f2933;
      background: #fff;
      font: 10.5pt/1.58 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif;
      overflow-wrap: anywhere;
    }
    .document-header { margin: 0 0 24px; padding-bottom: 14px; border-bottom: 2px solid #17202a; }
    h1 { margin: 0 0 8px; font-size: 23pt; line-height: 1.2; }
    .metadata { color: #68737d; font-size: 8.5pt; }
    .metadata span + span::before { content: " · "; }
    .message { break-inside: auto; margin: 0 0 22px; }
    .message + .message { border-top: 1px solid #d9dee3; padding-top: 18px; }
    .message header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 9px; }
    .message h2 { margin: 0; font-size: 13pt; }
    .message-user h2 { color: #0f5c5e; }
    .message-assistant h2 { color: #7a3f10; }
    time { color: #7b858e; font-size: 8pt; }
    .message-content > :first-child { margin-top: 0; }
    .message-content > :last-child { margin-bottom: 0; }
    p, ul, ol, blockquote, pre, table { margin: 0 0 10px; }
    h1, h2, h3, h4, h5, h6 { break-after: avoid; }
    h3 { margin: 16px 0 7px; font-size: 11.5pt; }
    h4, h5, h6 { margin: 14px 0 6px; font-size: 10.5pt; }
    ul, ol { padding-left: 22px; }
    blockquote { border-left: 3px solid #aab3bb; color: #4b5560; padding-left: 12px; }
    code {
      border-radius: 3px;
      background: #f1f3f5;
      padding: 1px 3px;
      font: 8.7pt/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC",
        "Microsoft YaHei", "Noto Sans Mono CJK SC", monospace;
    }
    pre {
      break-inside: auto;
      white-space: pre-wrap;
      border: 1px solid #d9dee3;
      border-radius: 5px;
      background: #f7f8f9;
      padding: 10px;
    }
    pre code { background: transparent; padding: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 9pt; }
    th, td { border: 1px solid #cfd5da; padding: 5px 7px; text-align: left; vertical-align: top; }
    th { background: #f1f3f5; }
    a { color: #145f8c; text-decoration: underline; }
    .attachments { margin-top: 11px; color: #4f5963; font-size: 9pt; }
    .attachments h3 { margin: 0 0 4px; font-size: 9pt; }
    .attachments ul { margin: 0; }
    .attachments span, .image-placeholder, .empty-message { color: #737d86; }
    .message-images { display: grid; gap: 10px; margin-top: 12px; }
    .message-images figure { break-inside: avoid; margin: 0; }
    .message-images img { display: block; max-width: 100%; max-height: 220mm; object-fit: contain; }
  </style>
</head>
<body>
  <header class="document-header">
    <h1>${escapeHtml(document.title)}</h1>
    <div class="metadata">
      <span>Created ${escapeHtml(toIsoDate(document.createdAt))}</span>
      <span>Updated ${escapeHtml(toIsoDate(document.updatedAt))}</span>
      <span>Exported ${escapeHtml(toIsoDate(document.exportedAt))}</span>
    </div>
  </header>
  <main>${messages}</main>
</body>
</html>`
}
