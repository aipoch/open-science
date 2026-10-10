import { randomUUID } from 'node:crypto'
import type { ManagedPreviewResources } from '../managed-preview-resources'
import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import { createManagedPreviewOwnerRegistry } from '../managed-preview-owner-registry'
import {
  createReviewerPagedContentResolver,
  MAX_REVIEWER_PREVIEW_SOURCE_BYTES
} from './paged-preview-resolver'
import { renderPdfPagePreviews } from '../uploads/attachment-media'
import type { ReviewerPagedContentResolver } from './host-sdk'
import type { DesktopNativeOperation } from '../desktop-native-contract'

type ReviewerResources = Pick<
  ManagedPreviewResources,
  'acquireResolvedFile' | 'release' | 'inspect' | 'acquire' | 'readRange' | 'releaseOwner'
>
type ResolverFactory = (resources: ReviewerResources) => ReviewerPagedContentResolver
let createDesktopResolver: ResolverFactory | undefined
export function configureDesktopReviewer(factory: ResolverFactory): void {
  if (createDesktopResolver) throw new Error('Desktop Reviewer is already configured.')
  createDesktopResolver = factory
}
export const createReviewerHostPagedContentResolver: ResolverFactory = (resources) =>
  createDesktopResolver
    ? createDesktopResolver(resources)
    : createReviewerPagedContentResolver({ renderPdfPages: renderPdfPagePreviews })

export function createRemoteReviewerResolver(
  resources: ReviewerResources,
  render: (operation: DesktopNativeOperation, signal?: AbortSignal) => Promise<unknown>
): ReviewerPagedContentResolver {
  const leases = new ApplicationCallerLeaseRegistry()
  const registry = createManagedPreviewOwnerRegistry(resources)
  return createReviewerPagedContentResolver({
    renderPdfPages: renderPdfPagePreviews,
    renderOffice: async (request) => {
      request.signal?.throwIfAborted()
      const owner = leases.acquire({ surface: 'task', leaseId: randomUUID() })
      const { ownerId } = registry.register(owner.lease)
      request.signal?.addEventListener('abort', owner.release, { once: true })
      let resource: Awaited<ReturnType<ReviewerResources['acquireResolvedFile']>> | undefined
      try {
        resource = await resources.acquireResolvedFile(
          ownerId,
          {
            path: request.path,
            mimeType:
              request.format === 'docx'
                ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            verifiedObservation: request.verifiedObservation,
            verifiedChecksum: request.verifiedChecksum
          },
          MAX_REVIEWER_PREVIEW_SOURCE_BYTES
        )
        request.signal?.throwIfAborted()
        return (await render(
          {
            operation: 'reviewer-render',
            input: {
              artifactVersionId: request.artifactVersionId,
              format: request.format as 'docx' | 'pptx',
              pages: request.pages,
              includePreview: request.includePreview,
              maxBytes: request.maxBytes,
              resource
            }
          },
          request.signal
        )) as Awaited<ReturnType<ReviewerPagedContentResolver>>
      } finally {
        request.signal?.removeEventListener('abort', owner.release)
        // A revoked registry lease already removed its resource tombstones. Owner-scoped cleanup
        // remains idempotent and also reaps an acquisition that completed after that revocation.
        resources.releaseOwner(ownerId)
        owner.release()
      }
    }
  })
}
