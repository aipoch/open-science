import { posix } from 'node:path'

import type {
  ArtifactLineageProvenance,
  ArtifactVersionProvenance
} from '../../shared/artifact-provenance'
import { sha256 } from '../artifacts/provenance-canonical'
import {
  buildArtifactVersionRoCrateArchive,
  type ArtifactVersionRoCrateSource
} from '../artifacts/ro-crate-export'
import {
  DepositPreviewStaleError,
  type ArtifactDepositContributor,
  type ArtifactDepositLicense,
  type ArtifactDepositReference,
  type ArtifactDepositRelatedIdentifier
} from './deposit-provider'
import type { ArtifactDepositSourceReader } from './artifact-deposit-owner'

export type ArtifactDepositSourceContext = {
  description?: string
  contributors: ArtifactDepositContributor[]
  license?: ArtifactDepositLicense
}

export type ArtifactDepositProvenanceRepository = {
  getLineage(request: {
    projectId: string
    appSessionId: string
    artifactId: string
    versionId?: string
  }): Promise<ArtifactLineageProvenance | undefined>
  getVersionProvenance(
    request: {
      projectId: string
      appSessionId: string
      artifactId: string
      versionId: string
    },
    sections?: { execution: boolean; messages: boolean; review: boolean }
  ): Promise<ArtifactVersionProvenance>
}

const resourceType = (itemType: string): string => {
  const normalized = itemType.toLowerCase()
  if (normalized.includes('dataset') || normalized.includes('data')) return 'dataset'
  if (normalized.includes('software') || normalized.includes('code')) return 'software'
  return 'publication'
}

const relatedIdentifiers = (
  literature: ArtifactVersionProvenance['literature']
): ArtifactDepositRelatedIdentifier[] => {
  if (!literature) return []
  const related: ArtifactDepositRelatedIdentifier[] = []
  const seen = new Set<string>()
  for (const reference of literature.references) {
    const doi = reference.item?.identifiers.find((identifier) => identifier.scheme === 'doi')
    const identifier = doi?.value ?? reference.item?.url
    if (!identifier || seen.has(identifier)) continue
    seen.add(identifier)
    related.push({
      identifier,
      relation: 'references',
      resourceType: resourceType(reference.item?.itemType ?? 'publication')
    })
  }
  return related
}

const buildCrateSource = (provenance: ArtifactVersionProvenance): ArtifactVersionRoCrateSource => ({
  descriptor: provenance.descriptor,
  contentStatus: provenance.contentStatus,
  evidence: provenance.evidence,
  ...(provenance.execution ? { execution: provenance.execution } : {}),
  ...(provenance.review.state === 'available' ? { review: provenance.review.value } : {})
})

const defaultDescription = (title: string, filename: string, versionNumber: number): string =>
  `Published Open Science Artifact Version v${versionNumber} (${filename}) from session "${title}".`

export const createArtifactVersionDepositSourceReader = (options: {
  repository: ArtifactDepositProvenanceRepository
  buildCrate?: (source: ArtifactVersionRoCrateSource) => Uint8Array
  resolveContext?: (input: {
    reference: ArtifactDepositReference
    lineage: ArtifactLineageProvenance
    provenance: ArtifactVersionProvenance
  }) => Promise<ArtifactDepositSourceContext>
}): ArtifactDepositSourceReader => ({
  read: async (reference) => {
    const request = {
      projectId: reference.projectId,
      appSessionId: reference.sessionId,
      artifactId: reference.artifactId,
      versionId: reference.versionId
    }
    const lineage = await options.repository.getLineage(request)
    if (!lineage) return undefined
    const version =
      lineage.selectedVersion?.versionId === reference.versionId
        ? lineage.selectedVersion
        : lineage.versions.find((candidate) => candidate.versionId === reference.versionId)
    if (!version) return undefined
    if (version.state !== 'finalized') {
      throw new DepositPreviewStaleError(
        `Artifact Version ${reference.versionId} is not finalized and cannot be deposited.`
      )
    }
    const provenance = await options.repository.getVersionProvenance(
      { ...request, versionId: reference.versionId },
      { execution: false, messages: false, review: false }
    )
    if (
      provenance.descriptor.versionId !== reference.versionId ||
      provenance.evidence.version_id !== reference.versionId ||
      provenance.descriptor.checksum !== provenance.evidence.checksum
    ) {
      throw new DepositPreviewStaleError(
        'Artifact Version provenance does not match its descriptor.'
      )
    }

    const context = (await options.resolveContext?.({ reference, lineage, provenance })) ?? {
      contributors: []
    }
    const contributors = context.contributors.length
      ? context.contributors
      : [{ name: provenance.evidence.agent_name ?? 'Open Science contributor' }]
    const title = lineage.originSession.title?.trim() || lineage.filename
    const crate = (options.buildCrate ?? buildArtifactVersionRoCrateArchive)(
      buildCrateSource(provenance)
    )
    return {
      artifact: {
        ...reference,
        versionNumber: provenance.evidence.version_number,
        filename: provenance.evidence.filename,
        checksum: provenance.evidence.checksum,
        sizeBytes: provenance.evidence.size_bytes,
        ...(provenance.evidence.content_type
          ? { contentType: provenance.evidence.content_type }
          : {}),
        createdAt: provenance.evidence.created_at
      },
      session: {
        title,
        description:
          context.description ??
          defaultDescription(
            title,
            provenance.evidence.filename,
            provenance.evidence.version_number
          )
      },
      contributors,
      ...(context.license ? { license: context.license } : {}),
      relatedIdentifiers: relatedIdentifiers(provenance.literature),
      crate: {
        filename: `${posix.basename(provenance.evidence.filename)}.ro-crate.zip`,
        checksum: sha256(Buffer.from(crate)),
        sizeBytes: crate.byteLength,
        bytes: crate
      }
    }
  }
})
