import type { NotebookRunRecord } from '../../shared/notebook'

export type RunReference = { storage: 'file'; runId: string; sha256: string; bytes: number }
export type StoredNotebookRun = NotebookRunRecord | RunReference

export const isNotebookRunReference = (value: unknown): value is RunReference => {
  if (!value || typeof value !== 'object') return false
  const ref = value as RunReference
  return (
    ref.storage === 'file' &&
    typeof ref.runId === 'string' &&
    typeof ref.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(ref.sha256) &&
    Number.isSafeInteger(ref.bytes) &&
    ref.bytes > 0
  )
}
