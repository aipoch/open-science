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
