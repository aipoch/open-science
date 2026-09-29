// A local reference travels as ordinary, readable MessagePart text. It adds no .science fields.
// The UUID resolves only against the current Project's local question-context repository.
export type ReplayReferenceTextPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'reference'
      text: string
      id: string
      label: string
    }
export const replayReferenceText = (id: string, label: string): string =>
  `[${label.replace(/[[\]\r\n]/g, ' ')}](#research-replay:${id})`

export const splitReplayReferenceText = (text: string): ReplayReferenceTextPart[] => {
  const pattern = /\[([^\]\n]{1,200})\]\(#research-replay:([a-zA-Z0-9-]{1,100})\)/g
  const parts: ReplayReferenceTextPart[] = []
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index
    if (index > offset) parts.push({ kind: 'text', text: text.slice(offset, index) })
    parts.push({ kind: 'reference', text: match[0], label: match[1], id: match[2] })
    offset = index + match[0].length
  }
  if (offset < text.length) parts.push({ kind: 'text', text: text.slice(offset) })
  return parts
}
