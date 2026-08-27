import type { GetArtifactVersionProvenanceRequest } from './artifact-provenance'
import type { NotebookKernelKind } from './notebook'
import type { AgentFrameworkId } from './settings'

type ArtifactCodeReconstructionBase = {
  code: string
  language: NotebookKernelKind
  generatedAt: string
  sourceTruncated: boolean
}

export type ArtifactCodeReconstruction =
  | (ArtifactCodeReconstructionBase & {
      origin: 'app-replay'
    })
  | (ArtifactCodeReconstructionBase & {
      origin: 'llm'
      frameworkId: AgentFrameworkId
      model: string
    })

export type ArtifactCodeReconstructionState =
  | {
      state: 'ready'
      origin: 'app-replay' | 'llm'
      language: NotebookKernelKind
      sourceTruncated: boolean
    }
  | {
      state: 'cached'
      value: ArtifactCodeReconstruction
    }
  | {
      state: 'unavailable'
      reason:
        | 'execution-unavailable'
        | 'producer-unavailable'
        | 'producer-script-missing'
        | 'helper-evidence-incomplete'
        | 'supporting-code-incomplete'
    }

export type GetArtifactCodeReconstructionRequest = GetArtifactVersionProvenanceRequest
export type GenerateArtifactCodeReconstructionRequest = GetArtifactVersionProvenanceRequest
