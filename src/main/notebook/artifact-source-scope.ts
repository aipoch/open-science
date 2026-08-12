import type { NotebookArtifactSourceScopeProvider } from '../acp/artifact-turn-owner'
import { createFrameNotebookLane, createRootNotebookLane } from './lane-identity'
import { getNotebookDataRoot, getNotebookSessionRoot } from './repository'

const createNotebookArtifactSourceScopeProvider =
  (dataRoot: string): NotebookArtifactSourceScopeProvider =>
  ({ projectId, appSessionId, rootFrameId, agentFrameId }) => {
    const lane =
      agentFrameId === rootFrameId
        ? createRootNotebookLane(projectId, appSessionId, agentFrameId)
        : createFrameNotebookLane(projectId, appSessionId, agentFrameId)
    return {
      notebookSessionId: appSessionId,
      notebookDataDir: getNotebookDataRoot(dataRoot, projectId, appSessionId, lane),
      notebookSessionRoot: getNotebookSessionRoot(dataRoot, projectId, appSessionId, lane)
    }
  }

export { createNotebookArtifactSourceScopeProvider }
