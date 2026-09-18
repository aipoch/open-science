import { DATA_ROOT_SELECTION_CHANGED } from '../../../shared/storage'

// Existing backend diagnostics retain their details; this actionable selection error is shared
// by inspection, adoption and migration and translated at every renderer entry point.
export const storageErrorMessage = (
  message: string | undefined,
  t: (key: string) => string
): string | undefined =>
  message === DATA_ROOT_SELECTION_CHANGED
    ? t('The selected data folder changed. Check the location and confirm it again.')
    : message
