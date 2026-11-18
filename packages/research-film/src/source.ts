export const RESEARCH_VIDEO_SOURCE_FILE_LIMIT_BYTES = 100 * 1024 * 1024

export const RESEARCH_VIDEO_PLAYER_SIZE_ERROR =
  'The film exceeds 200 MiB. Shorten it or use smaller media.'

export function assertResearchVideoPlayerSize(bytes: number): void {
  if (bytes > 200 * 1024 * 1024) throw new Error(RESEARCH_VIDEO_PLAYER_SIZE_ERROR)
}

export type ResearchVideoSessionSource = {
  sessionTitle: string
  project: string
  sessionApp?: import('./session-app.js').SessionAppDescription
  messages: Array<{ i: number; id: string; role: string; md: string; artifactIds: string[] }>
  replay?: {
    schemaVersion: 1
    events: ReplayEvidence[]
    omissions: string[]
  }
  provenance: {
    projectId: string
    sessionId: string
    branchId?: string
    mode?: 'research-explanation' | 'operation-replay'
    sourceRevision?: number
    sessionAppSha256?: string
    sourceClaimsIndependentlyVerified: boolean
  }
}

export type ReplayEvidence = {
  id: string
  kind:
    | 'human-input'
    | 'agent-message'
    | 'application-event'
    | 'attachment'
    | 'result'
    | 'plan'
    | 'execution'
    | 'remote-job'
    | 'review'
  messageId: string
  title: string
  text: string
  status?: string
  recordedAt?: number
  artifactId?: string
  image?: string
  previewText?: string
  execution?: { code: string; output: string; language: string }
}

/** Read-only host records. Remote handles and execution authority never enter a film. */
export type ReplayRecords = {
  runs?: Array<{
    id: string
    messageId?: string
    branchId?: string
    status: string
    code: string
    output: string
    language: string
    recordedAt: number
  }>
  reviews: Array<{
    id: string
    messageId: string
    status: string
    text: string
    recordedAt: number
  }>
  jobs: Array<{
    id: string
    status: string
    text: string
    recordedAt: number
    producerRunId?: string
  }>
}
