import type {
  GetProjectFilesOverviewRequest,
  ListProjectFilesRequest,
  ProjectFileItem,
  ProjectFilesOverview,
  ProjectFilesPage
} from '../../../../shared/project-files'

type GetProjectFilesOverview = (
  request: GetProjectFilesOverviewRequest
) => Promise<ProjectFilesOverview>
type ListProjectFiles = (request: ListProjectFilesRequest) => Promise<ProjectFilesPage>
type RepairProjectFilesIndex = (request: { projectId: string }) => Promise<void>

type ListAllSessionArtifactsOptions = {
  getOverview: GetProjectFilesOverview
  listFiles: ListProjectFiles
  repairIndex: RepairProjectFilesIndex
  projectId: string
  sessionId: string
}

const SESSION_ARTIFACT_PAGE_LIMIT = 100

// Hides cursor traversal from the dialog so its interface is one complete Source Session snapshot.
const listAllSessionArtifacts = async ({
  getOverview,
  listFiles,
  repairIndex,
  projectId,
  sessionId
}: ListAllSessionArtifactsOptions): Promise<ProjectFileItem[]> => {
  let overview = await getOverview({ projectId })
  if (!overview.isIndexComplete) {
    await repairIndex({ projectId })
    overview = await getOverview({ projectId })
    if (!overview.isIndexComplete) {
      throw new Error('Some Session Artifacts could not be indexed yet.')
    }
  }

  const artifacts: ProjectFileItem[] = []
  let cursor: string | undefined

  do {
    const page = await listFiles({
      projectId,
      collection: { kind: 'sessionArtifacts', sessionId },
      ...(cursor ? { cursor } : {}),
      limit: SESSION_ARTIFACT_PAGE_LIMIT
    })
    artifacts.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)

  return artifacts
}

export { listAllSessionArtifacts }
export type {
  GetProjectFilesOverview,
  ListAllSessionArtifactsOptions,
  ListProjectFiles,
  RepairProjectFilesIndex
}
