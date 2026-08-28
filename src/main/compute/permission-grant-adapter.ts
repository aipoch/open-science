import type { ComputeApprovalDecision } from '../../shared/compute'
import type { PermissionCapability, PermissionGrantScope } from '../../shared/permission-grants'
import {
  PermissionGrantTargetUnavailableError,
  type PermissionGrantRegistry
} from '../permission-grants/registry'

type LegacyComputeGrant = { projectId: string; operation: string; providerId: string }

type LegacyComputeGrantPort = {
  listComputeGrants(): Promise<LegacyComputeGrant[]>
  clearComputeGrants(): Promise<void>
  hasComputeGrant(grant: LegacyComputeGrant): Promise<boolean>
  addComputeGrant(grant: LegacyComputeGrant): Promise<unknown>
}

type LegacyComputeGrantMigrationPort = Pick<
  LegacyComputeGrantPort,
  'listComputeGrants' | 'clearComputeGrants'
>

type ComputeGrantContext = {
  projectId: string
  sessionId: string
  operation: string
  providerId: string
}

type ComputePermissionGrantAdapter = {
  migrateLegacy(): Promise<void>
  resolve(context: ComputeGrantContext): Promise<'session' | 'project' | 'global' | undefined>
  remember(context: ComputeGrantContext, decision: ComputeApprovalDecision): Promise<void>
}

class LegacyComputeGrantOwnersUnavailableError extends Error {
  constructor(readonly unavailableCount: number) {
    super(
      `${unavailableCount} legacy Compute grant owner${unavailableCount === 1 ? ' is' : 's are'} unavailable`
    )
    this.name = 'LegacyComputeGrantOwnersUnavailableError'
  }
}

const computeCapability = (
  context: Pick<ComputeGrantContext, 'operation' | 'providerId'>
): PermissionCapability => ({
  kind: 'execution',
  key: `exec:compute/${context.providerId}/${context.operation}`,
  qualifier: { mode: 'any' }
})

const computeScope = (
  context: ComputeGrantContext,
  decision: ComputeApprovalDecision
): PermissionGrantScope | undefined => {
  if (decision === 'session') {
    return { kind: 'session', projectId: context.projectId, sessionId: context.sessionId }
  }
  if (decision === 'project') return { kind: 'project', projectId: context.projectId }
  if (decision === 'global') return { kind: 'global' }
  return undefined
}

const createComputePermissionGrantAdapter = (
  registry: PermissionGrantRegistry,
  legacy?: LegacyComputeGrantMigrationPort
): ComputePermissionGrantAdapter => {
  let migration: Promise<void> | undefined
  const migrateLegacy = (): Promise<void> => {
    if (!legacy) return Promise.resolve()
    if (migration) return migration

    const attempt = (async () => {
      const grants = await legacy.listComputeGrants()
      let firstWriteFailure: unknown
      let hasWriteFailure = false
      let unavailableCount = 0
      for (const grant of grants) {
        try {
          await registry.remember({
            capability: computeCapability(grant),
            scope: { kind: 'project', projectId: grant.projectId }
          })
        } catch (error) {
          if (error instanceof PermissionGrantTargetUnavailableError) {
            unavailableCount += 1
          } else if (!hasWriteFailure) {
            firstWriteFailure = error
            hasWriteFailure = true
          }
        }
      }
      if (hasWriteFailure) throw firstWriteFailure
      if (unavailableCount > 0) {
        throw new LegacyComputeGrantOwnersUnavailableError(unavailableCount)
      }
      // Clear only after every source row has a successful Registry write. Target-unavailable rows
      // are not silently discarded: the additive import is idempotent and settings.json remains the
      // retry source until the complete batch succeeds.
      await legacy.clearComputeGrants()
    })()
    migration = attempt
    void attempt.catch((error) => {
      // A deleted owner cannot become live again during this process. Cache that degraded result so
      // every Compute request does not replay the same additive import; the next app start retries it.
      // Transient Registry failures remain retryable in the current process.
      if (migration === attempt && !(error instanceof LegacyComputeGrantOwnersUnavailableError)) {
        migration = undefined
      }
    })
    return attempt
  }

  const awaitUsableMigration = async (): Promise<void> => {
    try {
      await migrateLegacy()
    } catch (error) {
      // Orphaned legacy rows keep the complete settings.json source intact, but must not prevent new
      // Compute approvals from using the Registry. Database/write failures still fail closed.
      if (!(error instanceof LegacyComputeGrantOwnersUnavailableError)) throw error
    }
  }

  return {
    migrateLegacy,

    async resolve(context) {
      await awaitUsableMigration()
      const match = await registry.resolve(computeCapability(context), context)
      return match?.matchedScope
    },

    async remember(context, decision) {
      await awaitUsableMigration()
      const scope = computeScope(context, decision)
      if (!scope) return
      await registry.remember({ capability: computeCapability(context), scope })
    }
  }
}

export { createComputePermissionGrantAdapter }
export type { ComputeGrantContext, ComputePermissionGrantAdapter, LegacyComputeGrantPort }
