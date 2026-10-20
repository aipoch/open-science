import { readJournalFile } from '@aipoch/journal-catalog/files'

self.onmessage = async (
  event: MessageEvent<{ bytes: ArrayBuffer; name: string; sheet?: string }>
): Promise<void> => {
  try {
    self.postMessage({
      result: await readJournalFile(event.data.bytes, event.data.name, event.data.sheet)
    })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
