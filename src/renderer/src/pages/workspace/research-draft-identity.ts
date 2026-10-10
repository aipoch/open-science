import type { ResearchMembership } from '../../../../shared/session-persistence'

export const ordinaryDraftKey = (projectId: string): string => `new:${projectId}`

// Local import identity distinguishes two imports of the same archive. JSON encoding also
// prevents delimiter-bearing identifiers from accidentally sharing an unsent draft.
export const researchIdentity = (source: ResearchMembership): string =>
  JSON.stringify([source.sourceProjectId, source.sourceSessionId, source.sourceImportId])

export const researchDraftKey = (source: ResearchMembership): string =>
  `new-research:${researchIdentity(source)}`

export const sameResearch = (
  left: ResearchMembership | undefined,
  right: ResearchMembership | undefined
): boolean => Boolean(left && right && researchIdentity(left) === researchIdentity(right))
