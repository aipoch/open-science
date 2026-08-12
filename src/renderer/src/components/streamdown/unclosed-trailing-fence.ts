type TrailingCodeFence = {
  language: string
  code: string
}

const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/

const stripTrailingNewlines = (text: string): string => text.replace(/[\r\n]+$/, '')

// Recovers the trailing unclosed fence's language and partial source, mirroring the fence
// tracking Streamdown uses to set `isIncomplete` on the last block.
const getUnclosedTrailingFence = (content: string): TrailingCodeFence | null => {
  const lines = content.split('\n')
  let openerIndex = -1
  let fenceChar = ''
  let fenceLength = 0

  lines.forEach((line, index) => {
    const fence = FENCE_LINE.exec(line)
    if (!fence) return
    if (openerIndex === -1) {
      openerIndex = index
      fenceChar = fence[1][0]
      fenceLength = fence[1].length
    } else if (fence[1][0] === fenceChar && fence[1].length >= fenceLength) {
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
