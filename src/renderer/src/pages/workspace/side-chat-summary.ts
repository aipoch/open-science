import { parseSideChatAnnotationText } from '../../../../shared/annotations'
import type { SideChatView } from './use-side-chat-controller'

export const sideChatSummary = (view: SideChatView): string => {
  const first = view.entries.find((entry) => entry.kind === 'message' && entry.role === 'user')
  const raw = first?.kind === 'message' ? first.text : view.draft
  const parsed = parseSideChatAnnotationText(raw)
  const item = parsed?.items[0]
  const annotation = view.annotations?.[0]
  const summary = parsed
    ? parsed.text || (item?.type === 'quote' ? item.content : item?.instruction)
    : raw
  return (
    summary ||
    annotation?.note ||
    (annotation?.kind === 'text' ? annotation.quote : '')
  ).slice(0, 160)
}
