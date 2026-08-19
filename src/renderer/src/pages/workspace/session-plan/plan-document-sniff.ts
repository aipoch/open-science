import {
  parsePlanDocumentV1,
  type PlanDocumentV1
} from '../../../../../shared/session-plan/contract'

// Detects whether a previewed JSON file is a serialized Session Plan document. parsePlanDocumentV1
// gates on schema_version before any structural validation, so ordinary JSON rejects at O(1)
// inside the parse; a false positive would have to be a structurally valid Plan.
export const parsePlanDocumentFromPreviewContent = (
  content: string
): PlanDocumentV1 | undefined => {
  try {
    return parsePlanDocumentV1(JSON.parse(content))
  } catch {
    return undefined
  }
}
