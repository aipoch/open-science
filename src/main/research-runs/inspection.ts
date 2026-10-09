import { z } from 'zod'
import { satisfies, validRange } from 'semver'
import {
  inspectResearchRunRequestSchema,
  type ResearchRunInspection,
  type ResearchRunDescriptor,
  type ResearchRunRuntime
} from '../../shared/research-run-launcher'
import type { CallerContext } from '../caller-context'
import {
  createResearchMaterialInspectionAuthority,
  type ResearchMaterialAuthorityDependencies
} from '../notebook/research-material-authority'
import { inspectResearchMaterials } from '../notebook/research-materials'

export type ResearchRunInspectionPort = {
  inspect(
    value: unknown,
    caller: CallerContext,
    signal?: AbortSignal
  ): Promise<ResearchRunInspection>
}

/** A desktop read adapter, not an execution endpoint. Only verified retained import closure is
 * inspected; renderer-provided paths and package commands are never evaluated here. */
export function createResearchRunInspectionPort(dependencies: {
  materials: ResearchMaterialAuthorityDependencies
  runtimes: {
    runtimes(): Promise<{
      runtimes: ResearchRunRuntime[]
      diagnostics?: ResearchRunInspection['diagnostics']
    }>
  }
  assertOpen(): void
  track?<T>(operation: () => Promise<T>): Promise<T>
}): ResearchRunInspectionPort {
  return {
    async inspect(value, caller, signal) {
      const assertCurrent = (): void => {
        signal?.throwIfAborted()
        if (
          !caller.isAuthorizationCurrent() ||
          caller.location !== 'local' ||
          caller.surface !== 'electron'
        )
          throw new Error('research-run-inspection-unauthorized')
        dependencies.assertOpen()
      }
      const inspect = async (): Promise<ResearchRunInspection> => {
        assertCurrent()
        const request = inspectResearchRunRequestSchema.parse(value)
        const authority = await createResearchMaterialInspectionAuthority(dependencies.materials, {
          ...request,
          signal
        })
        // Explicit descriptor selection must still name a discovered description, never an
        // arbitrary shared Version relabelled by the renderer as an executable recipe.
        if (
          request.descriptorVersionId &&
          !authority.versions.some(
            (version) =>
              version.versionId === request.descriptorVersionId &&
              (version.descriptor || version.filename === 'research-reproduction.json')
          )
        )
          throw new Error('research-run-description-unavailable')
        const inspection = await inspectResearchMaterials(authority, {
          descriptorVersionId: request.descriptorVersionId,
          signal
        })
        assertCurrent()
        const runtimeState = await dependencies.runtimes.runtimes()
        // Runtime probing is asynchronous: reject replaced/reimported/archived sources, and
        // freeze the exact material snapshot again before returning a launchable choice.
        await createResearchMaterialInspectionAuthority(dependencies.materials, {
          projectId: request.projectId,
          sourceSessionId: request.sourceSessionId,
          sourceImportId: request.sourceImportId,
          expectedSourceIdentity: authority.source.identity,
          signal
        })
        assertCurrent()
        const descriptor = (version: ResearchRunDescriptor): ResearchRunDescriptor => ({
          versionId: version.versionId,
          filename: version.filename,
          sha256: version.sha256,
          sizeBytes: version.sizeBytes
        })
        return {
          source: { ...authority.source, importId: request.sourceImportId },
          status: inspection.status,
          descriptorCandidates: inspection.descriptorCandidates.map(descriptor),
          ...(inspection.descriptor ? { descriptor: descriptor(inspection.descriptor) } : {}),
          plans: (inspection.description?.plans ?? []).map((plan) => {
            const materials = plan.materialKeys.map(
              (key) =>
                inspection.materials?.find((material) => material.key === key) ?? {
                  key,
                  status: 'missing' as const
                }
            )
            return {
              key: plan.key,
              title: plan.title,
              scope: plan.scope,
              claim: plan.claim,
              limitations: plan.limitations,
              materialKeys: plan.materialKeys,
              materials,
              materialReady: materials.every((material) => material.status === 'available'),
              compatibleRuntimeIds: runtimeState.runtimes
                .filter(
                  (runtime) =>
                    (!plan.requirements?.platforms ||
                      plan.requirements.platforms.includes(runtime.platform)) &&
                    (!plan.requirements?.node ||
                      (validRange(plan.requirements.node) !== null &&
                        satisfies(runtime.version, plan.requirements.node)))
                )
                .map((runtime) => runtime.runtimeId),
              entrypoints: (plan.entrypoints ?? []).map(({ materialKey, path }) => ({
                materialKey,
                ...(path ? { path } : {})
              })),
              ...(plan.requirements
                ? {
                    requirements: {
                      ...(plan.requirements.node ? { node: plan.requirements.node } : {}),
                      ...(plan.requirements.platforms
                        ? { platforms: plan.requirements.platforms }
                        : {})
                    }
                  }
                : {}),
              requiresSecrets: Boolean(
                inspection.description?.secrets?.some(
                  (secret) => secret.required && secret.planKeys.includes(plan.key)
                )
              )
            }
          }),
          runtimes: runtimeState.runtimes.map(({ runtimeId, kind, version, platform, arch }) => ({
            runtimeId,
            kind,
            version,
            platform,
            arch
          })),
          diagnostics: {
            nativeServiceSupported: runtimeState.diagnostics?.nativeServiceSupported ?? false,
            issues: runtimeState.diagnostics?.issues.map(({ code }) => ({ code })) ?? []
          }
        }
      }
      try {
        return await (dependencies.track ? dependencies.track(inspect) : inspect())
      } catch (error) {
        // Never send retained filenames, host paths, or arbitrary parser/probe error text to UI.
        if (error instanceof z.ZodError) throw new Error('research-run-inspection-invalid-request')
        throw new Error('research-run-inspection-unavailable')
      }
    }
  }
}
