export const RESEARCH_VIDEO_SOURCE_FILE_LIMIT_BYTES = 100 * 1024 * 1024

export type ResearchVideoSessionSource = {
  sessionTitle: string
  project: string
  messages: Array<{ i: number; id: string; role: string; md: string; artifactIds: string[] }>
  provenance: {
    projectId: string
    sessionId: string
    branchId?: string
    sourceRevision?: number
    sourceClaimsIndependentlyVerified: boolean
  }
}
