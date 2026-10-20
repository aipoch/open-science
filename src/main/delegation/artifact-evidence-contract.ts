import type { ArtifactFile } from '../../shared/artifacts'

export type SessionKey = Readonly<{ projectId: string; sessionId: string }>

export type DelegatedArtifactScope = Readonly<{
  session: SessionKey
  workspaceCwd?: string
  executionId: string
  attemptId: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
  agentName: string
}>

export type DelegatedArtifactProjectionScope = DelegatedArtifactScope &
  Readonly<{
    runtimeSegmentIds: readonly string[]
    terminalMessageId?: string
  }>

export type DelegatedArtifactHandle = Readonly<{
  execution?: Readonly<{ currentRunFile: string }>
  activateAt?(currentRunFile: string): Promise<void>
  finalize(terminalMessageId: string): Promise<void>
  dispose(): Promise<void>
}>

export type DelegatedArtifactEvidence = Readonly<{
  open(scope: DelegatedArtifactScope): Promise<DelegatedArtifactHandle>
  revoke?(scope: DelegatedArtifactProjectionScope): Promise<void>
  project(scope: DelegatedArtifactProjectionScope): Promise<readonly ArtifactFile[]>
}>
