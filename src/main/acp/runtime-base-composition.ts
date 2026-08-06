import { resolve } from 'node:path'

import { claudeCodeFramework } from '../agent-framework'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { createProductionPlanService } from '../session-plan/production-plan-service'
import { SessionPlanInteractionOwner } from '../session-plan/session-plan-interaction-owner'
import { AcpAgentConnectionAdapter } from './agent-connection-adapter'
import { AcpBackendGenerationOwner } from './backend-generation-owner'
import { AcpConnectionResourceOwner } from './connection-resource-owner'
import { ContextUsageTracker } from './context-usage-tracker'
import { createManagedFileReferenceResolver } from './file-reference-resolver'
import { AcpHandoffContinuityOwner } from './handoff-continuity-owner'
import { AcpPromptContentOwner } from './prompt-content-owner'
import { AcpPromptOutcomeFinalizer } from './prompt-outcome-finalizer'
import { AcpProviderPromptExecutor } from './provider-prompt-executor'
import type { AcpRuntimeOptions } from './runtime'
import { AcpRuntimeSnapshotOwner } from './runtime-snapshot-owner'
import { AcpSessionCapabilityOwner } from './session-capability-owner'
import { AcpSessionInteractionOwner } from './session-interaction-owner'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'
import { ArtifactTurnOwner } from './artifact-turn-owner'

// Composes only owners whose construction does not depend on Runtime callbacks. Callback-cycle owner
// groups remain explicit in Runtime until their own composition seam is cut over.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const composeAcpRuntimeBaseOwners = (options: AcpRuntimeOptions) => {
  const connectionResources = new AcpConnectionResourceOwner({
    closeMcpHost: async () => {
      await options.mcpHttpHost?.close()
    }
  })
  const backendGeneration = new AcpBackendGenerationOwner(options.framework ?? claudeCodeFramework)
  const contextUsageTracker = options.contextUsageTracker ?? new ContextUsageTracker()
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  const sessionInteractions = new AcpSessionInteractionOwner({
    cancelTimeoutMs: options.cancelTimeoutMs,
    setTimer,
    clearTimer
  })
  const sessionCapabilities = new AcpSessionCapabilityOwner({
    artifacts: options.artifacts,
    notebook: options.notebook,
    skillImport: options.skillImport,
    plan: options.plan,
    mcpHttpHost: options.mcpHttpHost
  })
  const artifactRepository = options.artifacts
    ? (options.artifacts.repository ?? new ArtifactRepository(options.artifacts.dataRoot))
    : undefined
  const artifactRunRegistry = options.artifacts
    ? (options.artifacts.runRegistry ?? new ArtifactRunRegistry())
    : undefined
  const artifactTurns =
    options.artifacts && artifactRepository && artifactRunRegistry
      ? new ArtifactTurnOwner({
          dataRoot: options.artifacts.dataRoot,
          repository: artifactRepository,
          runRegistry: artifactRunRegistry,
          issueRpcCapability: options.artifacts.issueRpcCapability,
          revokeRpcCapability: options.artifacts.revokeRpcCapability,
          provenance: options.artifacts.provenance,
          ...(options.notebook
            ? {
                notebook: {
                  setArtifactProvenanceContext: options.notebook.setArtifactProvenanceContext
                }
              }
            : {})
        })
      : undefined
  const planInteractions = new SessionPlanInteractionOwner()
  const planService =
    options.plan && artifactTurns && options.artifacts?.provenance?.resolveVersionContent
      ? createProductionPlanService({
          interactions: planInteractions,
          artifactTurns,
          provenance: {
            resolveVersionContent: (request) =>
              options.artifacts!.provenance!.resolveVersionContent!(request)
          },
          sessions: options.plan.sessions
        })
      : undefined
  const uploadRepository = options.uploads?.repository
  const fileReferenceResolver = createManagedFileReferenceResolver({
    uploads: uploadRepository,
    artifacts: artifactRepository,
    artifactVersions: options.artifacts?.provenance
  })

  return Object.freeze({
    snapshotOwner: new AcpRuntimeSnapshotOwner(resolve(options.defaultCwd)),
    connectionAdapter: new AcpAgentConnectionAdapter(),
    connectionResources,
    handoffContinuity: new AcpHandoffContinuityOwner(),
    backendGeneration,
    providerPromptExecutor: new AcpProviderPromptExecutor({
      backendGeneration,
      opencodeUsageFetch: options.opencodeUsageFetch
    }),
    contextUsageTracker,
    setTimer,
    clearTimer,
    sessionInteractions,
    sessionCapabilities,
    artifactRepository,
    artifactRunRegistry,
    artifactTurns,
    planInteractions,
    planService,
    promptContentOwner: new AcpPromptContentOwner({
      uploadRepository,
      fileReferenceResolver,
      inlineImageBudgetBytes: options.inlineImageBudgetBytes
    }),
    sessionPresentationPolicy: new AcpSessionPresentationPolicy(),
    promptOutcomeFinalizer: new AcpPromptOutcomeFinalizer()
  })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimeBaseOwners = ReturnType<typeof composeAcpRuntimeBaseOwners>

export { composeAcpRuntimeBaseOwners }
export type { AcpRuntimeBaseOwners }
