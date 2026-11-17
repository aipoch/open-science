import { z } from 'zod'

import type { ManagedFileIdentity } from '../../shared/managed-file-versions'
import { parseArtifactVersionLocator } from '../../shared/artifact-version-locator'
import { parseUploadVersionReference } from '../../shared/uploads'

const pathField = z
  .string()
  .min(1)
  .describe('The source.path of a pptx-slide annotation, or the deck path the user referenced.')

export const readPptxOutlineInput = z.object({ path: pathField }).strict()

export const proposePptxOperationsInput = z
  .object({
    path: pathField,
    expectedHeadVersionId: z
      .string()
      .min(1)
      .describe('The headVersionId returned by read_pptx_outline.'),
    operations: z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .max(200)
      .describe('Operations addressed by slideId and shapeId from read_pptx_outline.')
  })
  .strict()

export type ReadPptxOutlineInput = z.infer<typeof readPptxOutlineInput>
export type ProposePptxOperationsInput = z.infer<typeof proposePptxOperationsInput>

export type PptxTarget = Readonly<{ identity: ManagedFileIdentity; versionId: string }>

// Only immutable version references resolve; anything else is rejected rather than guessed.
export const resolvePptxTarget = (
  projectId: string,
  sessionId: string,
  path: string
): PptxTarget | undefined => {
  const artifact = parseArtifactVersionLocator(path)
  if (artifact) {
    if (artifact.projectId !== projectId || artifact.appSessionId !== sessionId) return undefined
    return {
      identity: { source: 'artifact', projectId, fileId: artifact.artifactId },
      versionId: artifact.versionId
    }
  }
  const upload = parseUploadVersionReference(path)
  if (!upload?.fileId || upload.projectId !== projectId || upload.sessionId !== sessionId) {
    return undefined
  }
  return {
    identity: { source: 'upload', projectId, fileId: upload.fileId },
    versionId: upload.versionId
  }
}
