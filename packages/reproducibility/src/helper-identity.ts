import type { NotebookHelperModuleEvidence } from './evidence'
export const notebookHelperEvidenceKey = (
  helper: Pick<
    NotebookHelperModuleEvidence,
    'helperId' | 'skillIdentity' | 'registeredGeneration' | 'sourceDigest'
  >
): string =>
  [helper.skillIdentity, helper.helperId, helper.registeredGeneration, helper.sourceDigest].join(
    '\0'
  )
