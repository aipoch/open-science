import { FENCE_LINE, createCodeFenceTracker } from './code-fence'

type TrailingCodeFence = {
  language: string
  code: string
}

const stripTrailingNewlines = (text: string): string => text.replace(/[\r\n]+$/, '')

// Recovers the trailing unclosed fence's language and partial source, mirroring the fence
// tracking Streamdown uses to set `isIncomplete` on the last block.
const getUnclosedTrailingFence = (content: string): TrailingCodeFence | null => {
  const lines = content.split('\n')
  const tracker = createCodeFenceTracker()
  let openerIndex = -1

  lines.forEach((line, index) => {
    const wasOpen = tracker.isOpen()
    const isOpen = tracker.feed(line)
    if (!wasOpen && isOpen) {
      openerIndex = index
    } else if (wasOpen && !isOpen) {
      openerIndex = -1
    }
  })

  if (openerIndex === -1) return null

  const info = lines[openerIndex].replace(FENCE_LINE, '').trim()
  return {
    language: info.split(/\s+/)[0] ?? '',
    code: stripTrailingNewlines(lines.slice(openerIndex + 1).join('\n'))
  }
}

export { getUnclosedTrailingFence, stripTrailingNewlines }
export type { TrailingCodeFence }
