import type { AgentMessage, ContentBlock, ToolResult } from './session-types'

export type ToolResultPage = {
  invocationId: string
  offset: number
  nextOffset: number | null
  totalCharacters: number
  text: string
  isError: boolean
}

export const TOOL_RESULT_READER = 'read_tool_result'
const MAX_BYTES = 50 * 1024
const MAX_LINES = 2000
const length = (text: string): number => {
  let count = 0
  for (let index = 0; index < text.length; count++)
    index += text.codePointAt(index)! > 0xffff ? 2 : 1
  return count
}
const head = (text: string, count: number): string => {
  let end = 0
  for (let i = 0; i < count && end < text.length; i++)
    end += text.codePointAt(end)! > 0xffff ? 2 : 1
  return text.slice(0, end)
}
const tail = (text: string, count: number): string => {
  let start = text.length
  for (let i = 0; i < count && start > 0; i++) {
    start--
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1]))
      start--
  }
  return text.slice(start)
}
const transportFits = (blocks: readonly ContentBlock[]): boolean => {
  let bytes = 0,
    lines = 1,
    seenText = false
  for (const block of blocks)
    if (block.type === 'text') {
      if (seenText) {
        bytes++
        lines++
      }
      seenText = true
      bytes += Buffer.byteLength(block.text)
      if (bytes > MAX_BYTES || lines > MAX_LINES) return false
      for (const character of block.text)
        if (character === '\n' && ++lines > MAX_LINES) return false
    }
  return true
}

/** Frozen at admission, not recalculated as old messages age. Media stays byte-for-byte intact. */
export function toolResultView(
  original: ToolResult,
  invocationId: string,
  budget: number,
  measure: (content: ContentBlock[]) => number
): ContentBlock[] | undefined {
  const fits = (content: ContentBlock[]): boolean =>
    transportFits(content) && measure(content) <= budget
  if (fits(original.content)) return undefined
  const lengths = original.content.map((block) => (block.type === 'text' ? length(block.text) : 0))
  const total = lengths.reduce((a, b) => a + b, 0)
  if (!total) return undefined
  const marker: ContentBlock = {
    type: 'text',
    text: `\n[Tool output shortened. Original text: ${total + Math.max(0, original.content.filter((block) => block.type === 'text').length - 1)} characters. If the visible evidence is sufficient, continue without reading more. If required information is missing, use ${TOOL_RESULT_READER} with invocationId=${JSON.stringify(invocationId)} and the relevant offset/limit. Follow nextOffset only while needed information is still missing. Do not repeat the original tool to retrieve its result.]`
  }
  const candidate = (count: number): ContentBlock[] => {
    const leading = Math.ceil(count * 0.8),
      trailingStart = total - (count - leading)
    let position = 0
    const view: ContentBlock[] = []
    original.content.forEach((block, index) => {
      if (block.type !== 'text') {
        view.push(block)
        return
      }
      const size = lengths[index]
      const first = Math.min(size, Math.max(0, leading - position))
      const last = Math.min(size - first, Math.max(0, position + size - trailingStart))
      position += size
      if (first + last === size) view.push(block)
      else if (first || last)
        view.push({
          type: 'text',
          text: head(block.text, first) + '\n[…]\n' + tail(block.text, last)
        })
    })
    return [...view, marker]
  }
  let low = 0,
    high = Math.min(total - 1, MAX_BYTES)
  let best = candidate(0)
  // If media or the reference itself cannot fit, normal request admission must fail explicitly.
  if (!fits(best)) return undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2),
      view = candidate(middle)
    if (fits(view)) {
      best = view
      low = middle + 1
    } else high = middle - 1
  }
  return best
}

/** Code-point offsets across original text blocks joined by a newline; no arbitrary file access. */
export function toolResultPage(
  message: AgentMessage,
  offset: number,
  limit: number,
  fits: (page: ToolResultPage) => boolean
): ToolResultPage {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 8192
  )
    throw new Error('Invalid tool result page range')
  const chunks: string[] = []
  let count = 0,
    seenText = false
  const add = (text: string): void => {
    for (const character of text) {
      if (count >= offset && chunks.length < limit) chunks.push(character)
      count++
    }
  }
  for (const block of message.content)
    if (block.type === 'text') {
      if (seenText) add('\n')
      seenText = true
      add(block.text)
    }
  if (offset > count) throw new Error('Tool result offset exceeds original text')
  const page = (size: number): ToolResultPage => ({
    invocationId: message.invocationId!,
    offset,
    nextOffset: offset + size < count ? offset + size : null,
    totalCharacters: count,
    text: chunks.slice(0, size).join(''),
    isError: message.isError === true
  })
  let low = count > offset ? 1 : 0,
    high = chunks.length,
    best: ToolResultPage | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2),
      value = page(middle)
    if (transportFits([{ type: 'text', text: JSON.stringify(value) }]) && fits(value)) {
      best = value
      low = middle + 1
    } else high = middle - 1
  }
  if (!best) throw new Error('Tool result page exceeds the model budget')
  return best
}
