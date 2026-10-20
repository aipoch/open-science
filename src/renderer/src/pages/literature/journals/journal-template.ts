import type { LiteratureRendererApi } from '../renderer-host'
import { createJournalTemplate } from '@aipoch/journal-catalog/files'
export const downloadJournalTemplate = async (
  api: Pick<LiteratureRendererApi, 'saveBlobFile'>,
  fail: (error: unknown) => void
): Promise<void> => {
  try {
    await api.saveBlobFile({
      suggestedName: 'journal-attributes-template.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: await createJournalTemplate()
    })
  } catch (error) {
    fail(error)
  }
}
