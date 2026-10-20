import { splitReplayReferenceText } from '../../shared/replay-reference'
import type { PrepareSessionReading } from '../session-replay/session-reading'

export type { PrepareSessionReading }

// Local locators are transport only. The durable reading association supplies a compact route on
// every turn, including after provider compaction; no source content is embedded here.
export const prepareReplayReferences = async (
  text: string,
  history: string | undefined,
  projectId: string,
  prepare?: PrepareSessionReading,
  sessionId = '',
  promptMessageId?: string
): Promise<{ text: string; history?: string; context?: string }> => {
  const sources = new Map<string, { projectId: string; id: string }>()
  const clean = (value: string, current: boolean): string =>
    splitReplayReferenceText(value)
      .map((part) => {
        if (part.kind === 'text') return part.text
        const source = { projectId: part.projectId ?? projectId, id: part.id }
        if (current) sources.set(JSON.stringify(source), source)
        return '[Linked Session]'
      })
      .join('')
  const cleanedText = clean(text, true)
  const cleanedHistory = history === undefined ? undefined : clean(history, false)
  if (sources.size && !prepare) throw new Error('Session reading is unavailable.')
  const context = await prepare?.({
    projectId,
    sessionId,
    promptMessageId,
    sources: [...sources.values()]
  })
  return { text: cleanedText, history: cleanedHistory, context }
}
