import { realpath, rm, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'

import type { PrismaClient } from '@prisma/client'

import {
  DEFAULT_UPLOAD_PROJECT_ID,
  PENDING_UPLOAD_SESSION_ID,
  parseUploadVersionReference,
  type DeleteUploadRequest
} from '../../shared/uploads'
import {
  UPLOADS_DIR,
  assertPathInsideRoot,
  assertSafePathSegment,
  getSessionUploadDir,
  getUploadRoot,
  isMissingFileError
} from './storage-helpers'

type ManagedUploadResolverOptions = {
  getClient?: () => Promise<PrismaClient>
}

type ResolvedManagedUpload = {
  path: string
  name: string
}

class ManagedUploadResolver {
  constructor(
    private readonly storageRoot: string,
    private readonly options: ManagedUploadResolverOptions = {}
  ) {}

  // Deletes an app-managed upload after resolving the caller path through the trust boundary.
  async deleteUpload(request: DeleteUploadRequest): Promise<void> {
    try {
      const filePath = await this.resolveManagedUploadPath(request)
      const pendingRoot = await realpath(
        getSessionUploadDir(this.storageRoot, PENDING_UPLOAD_SESSION_ID)
      )

      // The renderer interface is intentionally staged-only. Finalized uploads are Session-owned
      // bytes and must survive logical Session/Project deletion.
      assertPathInsideRoot(pendingRoot, filePath, 'Upload file is outside pending upload storage.')
      await rm(filePath, { force: true })
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }
  }

  // Resolves a renderer-provided upload path only after root and symlink checks pass.
  async resolveManagedUploadPath(
    request: DeleteUploadRequest,
    scope: { projectId?: string; sessionId?: string } = {}
  ): Promise<string> {
    if (
      typeof request !== 'object' ||
      request === null ||
      typeof request.path !== 'string' ||
      request.path.trim().length === 0
    ) {
      throw new Error('Invalid upload file path.')
    }

    const uploadVersion = parseUploadVersionReference(request.path)
    if (uploadVersion) {
      throw new Error('Upload Version content requires a managed file lease.')
    }

    const uploadRoot = getUploadRoot(this.storageRoot)
    const requestedPath = resolve(request.path)

    assertPathInsideRoot(uploadRoot, requestedPath)

    // Canonical paths catch symlinks that start inside storage but point outside it.
    const resolvedUploadRoot = await realpath(uploadRoot)
    const resolvedFilePath = await realpath(requestedPath)

    assertPathInsideRoot(resolvedUploadRoot, resolvedFilePath)

    if (!(await stat(resolvedFilePath)).isFile()) {
      throw new Error('Upload path is not a file.')
    }

    const safeProjectId = scope.projectId ? assertSafePathSegment(scope.projectId) : undefined
    const safeSessionId = scope.sessionId ? assertSafePathSegment(scope.sessionId) : undefined
    if (safeProjectId || safeSessionId) {
      const relativeUploadPath = relative(resolvedUploadRoot, resolvedFilePath).split(sep).join('/')
      const contentStorageKey = [UPLOADS_DIR, relativeUploadPath].join('/')
      if ((safeProjectId || safeSessionId) && this.options.getClient) {
        const client = await this.options.getClient()
        const version = await client.uploadVersion.findFirst({
          where: {
            state: 'ready',
            contentStorageKey,
            uploadFile: {
              is: {
                ...(safeProjectId ? { projectId: safeProjectId } : {}),
                ...(safeSessionId ? { sessionId: safeSessionId } : {})
              }
            }
          },
          select: { id: true }
        })
        if (version) return resolvedFilePath

        // Files is a project-scoped, main-maintained read model. A legacy path selected from that
        // surface may be referenced by any Session in the same Project.
        const indexedFile = safeProjectId
          ? await client.managedFile.findFirst({
              where: {
                projectId: safeProjectId,
                source: 'upload',
                storageKey: contentStorageKey,
                deletedAt: null
              },
              select: { seq: true }
            })
          : undefined
        if (indexedFile) return resolvedFilePath
      }

      // Canonical raw paths retain the project/session layout. Cross-session references deliberately
      // pass project-only scope.
      const scopedRoot = safeProjectId
        ? safeSessionId
          ? join(resolvedUploadRoot, safeProjectId, safeSessionId)
          : join(resolvedUploadRoot, safeProjectId)
        : safeSessionId
          ? getSessionUploadDir(this.storageRoot, safeSessionId)
          : undefined
      if (scopedRoot) {
        const resolvedScopedRoot = await realpath(scopedRoot).catch(() => undefined)
        if (resolvedScopedRoot) {
          try {
            assertPathInsideRoot(
              resolvedScopedRoot,
              resolvedFilePath,
              'Upload file belongs to a different project or session.'
            )
            return resolvedFilePath
          } catch {
            // Fall through to the single ownership error below.
          }
        }
      }

      // Pre-Version uploads were stored under default-project even when the owning Session was later
      // associated with another Project. SQLite must prove the source Session binding.
      const legacyPathSegments = relativeUploadPath.split('/')
      const legacySourceSessionId =
        legacyPathSegments[0] === DEFAULT_UPLOAD_PROJECT_ID && legacyPathSegments.length > 2
          ? legacyPathSegments[1]
          : undefined
      const requestedLegacySessionId = safeSessionId ?? legacySourceSessionId
      if (
        safeProjectId &&
        requestedLegacySessionId &&
        safeProjectId !== DEFAULT_UPLOAD_PROJECT_ID &&
        this.options.getClient
      ) {
        const safeLegacySessionId = assertSafePathSegment(requestedLegacySessionId)
        const client = await this.options.getClient()
        const originBindings = await client.fileOriginSession.findMany({
          where: { sessionId: safeLegacySessionId },
          select: { projectId: true },
          take: 2
        })
        const hasUnambiguousBinding =
          originBindings.length === 1 && originBindings[0].projectId === safeProjectId
        const legacySessionRoot = hasUnambiguousBinding
          ? await realpath(getSessionUploadDir(this.storageRoot, safeLegacySessionId)).catch(
              () => undefined
            )
          : undefined
        if (legacySessionRoot) {
          try {
            assertPathInsideRoot(
              legacySessionRoot,
              resolvedFilePath,
              'Upload file belongs to a different project or session.'
            )
            return resolvedFilePath
          } catch {
            // Fall through to the pending capability check and the ownership error below.
          }
        }
      }

      // A newly staged upload is a short-lived main-issued capability and has not acquired durable
      // project/session identity yet.
      if (safeProjectId && safeSessionId) {
        const pendingRoot = await realpath(
          join(resolvedUploadRoot, DEFAULT_UPLOAD_PROJECT_ID, PENDING_UPLOAD_SESSION_ID)
        ).catch(() => undefined)
        if (pendingRoot) {
          try {
            assertPathInsideRoot(
              pendingRoot,
              resolvedFilePath,
              'Upload file belongs to a different project or session.'
            )
            return resolvedFilePath
          } catch {
            // Fall through to the single ownership error below.
          }
        }
      }

      throw new Error('Upload file belongs to a different project or session.')
    }

    return resolvedFilePath
  }

  async resolveSessionUploadPath(
    sessionId: string,
    request: DeleteUploadRequest,
    projectId?: string
  ): Promise<string> {
    return (await this.resolveSessionUpload(sessionId, request, projectId)).path
  }

  async resolveSessionUpload(
    sessionId: string,
    request: DeleteUploadRequest,
    projectId?: string
  ): Promise<ResolvedManagedUpload> {
    const safeSessionId = assertSafePathSegment(sessionId)
    const safeProjectId = projectId ? assertSafePathSegment(projectId) : undefined
    return this.resolveManagedUpload(request, {
      sessionId: safeSessionId,
      projectId: safeProjectId
    })
  }

  async resolveManagedUpload(
    request: DeleteUploadRequest,
    scope: { projectId?: string; sessionId?: string } = {}
  ): Promise<ResolvedManagedUpload> {
    const path = await this.resolveManagedUploadPath(request, scope)
    if (!this.options.getClient) return { path, name: basename(path) }

    const resolvedUploadRoot = await realpath(getUploadRoot(this.storageRoot))
    const relativeUploadPath = relative(resolvedUploadRoot, path).split(sep).join('/')
    const contentStorageKey = [UPLOADS_DIR, relativeUploadPath].join('/')
    const client = await this.options.getClient()
    const version = await client.uploadVersion.findFirst({
      where: {
        state: 'ready',
        contentStorageKey,
        uploadFile: {
          is: {
            ...(scope.projectId ? { projectId: scope.projectId } : {}),
            ...(scope.sessionId ? { sessionId: scope.sessionId } : {})
          }
        }
      },
      select: { filename: true, originalFilename: true }
    })

    return { path, name: version?.originalFilename || version?.filename || basename(path) }
  }
}

export { ManagedUploadResolver }
export type { ResolvedManagedUpload }
