import type { NotebookRunRecord } from '../../../../../shared/notebook'
import type { PersistedToolActivity } from '../../../../../shared/session-persistence'

export const REPLAY_TEXT_LIMIT = 16 * 1024
export const REPLAY_TEXT_LINE_LIMIT = 200
export const replayExcerpt = (text: string, limit = REPLAY_TEXT_LIMIT): string =>
  text.slice(0, limit).split('\n').slice(0, REPLAY_TEXT_LINE_LIMIT).join('\n')

export const replayText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
// Keep every separately recorded output channel. One channel must never mask another.
export const replayToolOutputs = (
  activity: PersistedToolActivity
): { channel: 'terminal' | 'result' | 'content'; text: string }[] => [
  ...(activity.terminalOutput !== undefined
    ? [{ channel: 'terminal' as const, text: activity.terminalOutput }]
    : []),
  ...(activity.rawOutput !== undefined
    ? [{ channel: 'result' as const, text: replayText(activity.rawOutput) }]
    : []),
  ...(activity.toolContent?.length
    ? [{ channel: 'content' as const, text: replayText(activity.toolContent) }]
    : [])
]
export const replayNotebookText = (run: NotebookRunRecord): string[] => {
  if (!run.outputs.length)
    return [run.text.stdout, run.text.stderr, run.text.traceback, ...run.text.plain].filter(Boolean)
  return run.outputs
    .flatMap((output) => {
      switch (output.type) {
        case 'stream':
        case 'text':
          return [output.text]
        case 'json':
          return [replayText(output.data)]
        case 'error':
          return [output.traceback || `${output.name}: ${output.message}`]
        case 'display':
          return Object.entries(output.data)
            .filter(([mime]) => !mime.startsWith('image/'))
            .map(([, text]) => text)
      }
    })
    .filter(Boolean)
}
