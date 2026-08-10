import type { PrismaClient } from '@prisma/client'

import type { HostLineageDependencyRelation, HostLineageDirection } from '../../shared/host-lineage'

type ReadDependencyRelationsRequest = {
  projectId: string
  versionId: string
  direction: HostLineageDirection
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const sameDate = (left: Date | null, right: Date | null): boolean =>
  left?.getTime() === right?.getTime()

class ArtifactProvenanceDependencyReader {
  constructor(private readonly getClient: () => Promise<PrismaClient>) {}

  async readDependencyRelations(
    request: ReadDependencyRelationsRequest
  ): Promise<HostLineageDependencyRelation[]> {
    const client = await this.getClient()
    const rows = await client.artifactVersionInput.findMany({
      where:
        request.direction === 'up'
          ? { artifactVersionId: request.versionId }
          : {
              OR: [
                { sourceArtifactVersionId: request.versionId },
                { sourceUploadVersionId: request.versionId }
              ]
            },
      include: {
        artifactVersion: { include: { artifact: true } },
        sourceArtifactVersion: { include: { artifact: true } },
        sourceUploadVersion: { include: { uploadFile: true } }
      }
    })

    return rows
      .map((row) => {
        const output = row.artifactVersion
        const commonValid =
          output.artifact.projectId === request.projectId &&
          (output.state === 'pending' || output.state === 'finalized') &&
          row.sourceProjectId === request.projectId &&
          Number.isSafeInteger(row.ordinal) &&
          row.ordinal >= 0 &&
          (row.strongestAssociation === 'turn-attached' ||
            row.strongestAssociation === 'resolver-accessed') &&
          (request.direction === 'up'
            ? output.id === request.versionId
            : row.sourceArtifactVersionId === request.versionId ||
              row.sourceUploadVersionId === request.versionId)
        const artifactSource = row.sourceArtifactVersion
        const uploadSource = row.sourceUploadVersion
        const artifactValid =
          row.sourceKind === 'artifact-version' &&
          artifactSource !== null &&
          uploadSource === null &&
          row.sourceArtifactVersionId === row.inputFileVersionId &&
          row.sourceUploadVersionId === null &&
          artifactSource.id === row.inputFileVersionId &&
          artifactSource.artifact.projectId === request.projectId &&
          (artifactSource.state === 'pending' || artifactSource.state === 'finalized') &&
          row.sourceFileId === artifactSource.artifactId &&
          row.sourceSessionId === artifactSource.artifact.sessionId &&
          row.sourceVersionNumber === artifactSource.versionNumber &&
          sameDate(row.sourceCreatedAt, artifactSource.createdAt) &&
          row.filename === artifactSource.filename &&
          row.contentType === artifactSource.contentType &&
          row.sizeBytes === artifactSource.sizeBytes &&
          row.checksum === artifactSource.checksum &&
          row.storageKey === artifactSource.contentStorageKey
        const uploadValid =
          row.sourceKind === 'upload-version' &&
          uploadSource !== null &&
          artifactSource === null &&
          row.sourceUploadVersionId === row.inputFileVersionId &&
          row.sourceArtifactVersionId === null &&
          uploadSource.id === row.inputFileVersionId &&
          uploadSource.uploadFile.projectId === request.projectId &&
          uploadSource.state === 'ready' &&
          row.sourceFileId === uploadSource.uploadFileId &&
          row.sourceSessionId === uploadSource.uploadFile.sessionId &&
          row.sourceVersionNumber === uploadSource.versionNumber &&
          sameDate(row.sourceCreatedAt, uploadSource.createdAt) &&
          row.filename === (uploadSource.originalFilename || uploadSource.filename) &&
          row.contentType === uploadSource.contentType &&
          row.sizeBytes === uploadSource.sizeBytes &&
          row.checksum === uploadSource.checksum &&
          row.storageKey === uploadSource.contentStorageKey

        if (!commonValid || (!artifactValid && !uploadValid)) {
          throw new Error(`Artifact dependency relation is corrupt: ${row.id}`)
        }
        return {
          versionId: output.id,
          dependsOnVersionId: row.inputFileVersionId,
          ordinal: row.ordinal,
          sourceKind: row.sourceKind as 'artifact-version' | 'upload-version',
          inputFilename: row.filename,
          association: row.strongestAssociation as 'turn-attached' | 'resolver-accessed'
        }
      })
      .sort(
        (left, right) =>
          compareText(left.versionId, right.versionId) ||
          left.ordinal - right.ordinal ||
          compareText(left.sourceKind, right.sourceKind) ||
          compareText(left.dependsOnVersionId, right.dependsOnVersionId)
      )
  }
}

export { ArtifactProvenanceDependencyReader }
export type { ReadDependencyRelationsRequest }
