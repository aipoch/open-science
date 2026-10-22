import type { ModuleImpactManifest } from './load-module-impact.mjs'
import { classifyChanges, platformExecutionPlan } from './classify-pr-changes.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import { createModuleImpactShadowReport } from './module-impact-shadow.mjs'
import { selectWindowsCoreChecks } from './windows-core-plan.mjs'
import { validateModuleImpactManifest } from './validate-module-impact.mjs'

// Independent explanation contracts for representative real owners. These literals must be
// reviewed when production policy changes; they are never inferred from the candidate manifest.
export const productionFullReasonContracts = {
  renderer_ui:
    'Research overlays add portal-container ownership across replay, dialog, focus and window surfaces; dynamic context and DOM ownership extend the reviewed UI boundary and require full renderer validation.',
  i18n_main_adapter:
    'The i18n_main_adapter owner retains 21 explicit research consumer obligations beyond its reviewed source-derived edges, including research-reproduction.integration.test.ts, managed-auxiliary-output.test.ts, managed-execution-output.test.ts. 18 consumer cones have opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full main_runtime validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.',
  connector_builtins:
    'The connector_builtins owner retains 3 explicit research consumer obligations beyond its reviewed source-derived edges, including local-rpc-server.managed-execution.test.ts, managed-nested-generation.integration.test.ts, managed-output-publication.integration.test.ts. 3 consumer cones have opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full main_runtime validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.',
  main_literature:
    'The main_literature owner retains 45 explicit research consumer obligations beyond its reviewed source-derived edges, including research-reproduction.integration.test.ts, managed-auxiliary-output.test.ts, managed-execution-collection.integration.test.ts. 40 consumer cones have opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full main_runtime validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.'
} as const

type ModelOwner = {
  ownerPaths: string[]
  interfacePaths?: string[]
  ownerTests: string[]
  contractTests?: string[]
  consumerTests?: string[]
  consumerModules?: string[]
  fallbackCapability?: string
  capabilityOverlays?: string[]
}

// These are deliberately small policy models, not a projection of the production graph.
// Every caller declares its sources, evidence and edges; no production full marker is removed.
export const createModuleImpactModel = (
  owners: Record<string, ModelOwner>
): ModuleImpactManifest => {
  const modules = Object.fromEntries(
    Object.entries(owners).map(([id, owner]) => [
      id,
      {
        ownerPaths: [...owner.ownerPaths],
        interfacePaths: [
          ...(owner.interfacePaths ??
            owner.ownerPaths.filter((path) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)))
        ],
        testFiles: {
          owner: [...owner.ownerTests],
          contract: [...(owner.contractTests ?? [])],
          consumer: [...(owner.consumerTests ?? [])]
        },
        consumerModules: [...(owner.consumerModules ?? [])],
        fallbackCapability: owner.fallbackCapability ?? 'main_runtime',
        capabilityOverlays: [...(owner.capabilityOverlays ?? [])]
      }
    ])
  )
  return validateModuleImpactManifest({ schemaVersion: 1, modules })
}

// The production CLI intentionally has no manifest override. Model tests use its existing
// pure policy stages with one explicit manifest throughout; real CLI tests remain unmocked.
export const resolveModuleImpactModel = (
  changes: { path: string; status: string; previousPath?: string }[],
  manifest: ModuleImpactManifest,
  event = 'pull_request',
  platformPolicy: string | null = 'risk-v1'
): {
  plan: ReturnType<typeof selectWindowsCoreChecks>
  report: ReturnType<typeof createModuleImpactShadowReport>
} => {
  const candidate = classifyChanges(changes, undefined, { moduleManifest: manifest })
  const modulePlan = createAffectedTestPlan(
    changes,
    { status: 'not-requested', testFiles: [] },
    manifest
  )
  const report = createModuleImpactShadowReport(candidate, modulePlan)
  const selected =
    platformPolicy === 'risk-v1'
      ? platformExecutionPlan(report.resolved, changes, event)
      : report.resolved
  return {
    plan: selectWindowsCoreChecks(selected, modulePlan, changes, manifest, event),
    report
  }
}
