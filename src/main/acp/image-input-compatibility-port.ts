import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { VisionEvidenceSource } from './vision-evidence-repository'

export type PrepareImageInputCompatibilityInput = Readonly<{
  content: string | ContentBlock[]
  supportsImageInput: boolean
  projectId?: string
  sessionId?: string
  imageSources?: ReadonlyArray<VisionEvidenceSource | undefined>
  historyImageCount?: number
  /** Chat attachments retain their default reading guidance; Notebook results continue a task. */
  evidenceContext?: 'attachment' | 'notebook-tool-result'
  signal?: AbortSignal
}>

export type ImageInputCompatibilityPort = {
  isAvailable(): Promise<boolean>
  prepare(input: PrepareImageInputCompatibilityInput): Promise<string | ContentBlock[]>
}
