import { createHash } from 'node:crypto'
import { satisfies, validRange } from 'semver'
import {
  parseResearchDemoDescription,
  RESEARCH_DEMO_MAX_BYTES,
  type ResearchDemoCandidate,
  type ResearchDemoDescription,
  type ResearchDemoInspection,
  type ResearchDemoSource
} from '../../shared/research-demo'
import type { ResearchReproductionDescription } from '../../shared/research-reproduction'
import type { ManagedExecutionService } from '../notebook/managed-execution-service'
import {
  inspectResearchMaterials,
  type ResearchMaterialAuthority
} from '../notebook/research-materials'

export type ResolvedResearchDemo = {
  candidate: ResearchDemoCandidate
  description?: ResearchDemoDescription
  descriptorVersionId?: string
  materialKeys?: string[]
  materialVersions?: Record<string, string>
  runtimeId?: string
  entryPath?: string
}

function entryPath(
  description: ResearchReproductionDescription,
  demo: ResearchDemoDescription
): string | undefined {
  const plan = description.plans.find((item) => item.key === demo.planKey)
  if (!plan?.materialKeys.includes(demo.entrypoint.materialKey)) return undefined
  if (
    !plan.entrypoints?.some(
      (entry) =>
        entry.materialKey === demo.entrypoint.materialKey && entry.path === demo.entrypoint.path
    )
  )
    return undefined
  const material = description.materials.find((item) => item.key === demo.entrypoint.materialKey)
  if (!material || material.availability !== 'included') return undefined
  if (material.archive) {
    if (
      !demo.entrypoint.path ||
      !material.archive.entries.some(
        (entry) => entry.type === 'file' && entry.path === demo.entrypoint.path
      )
    )
      return undefined
    return material.restorePath + '/' + demo.entrypoint.path
  }
  return demo.entrypoint.path ? undefined : material.restorePath
}

/** Inspects only explicit demo files within an already admitted source closure. No execution. */
export async function inspectResearchDemos(
  source: ResearchDemoSource,
  authority: ResearchMaterialAuthority,
  runtimes: Awaited<ReturnType<ManagedExecutionService['runtimes']>>,
  signal?: AbortSignal
): Promise<{ inspection: ResearchDemoInspection; resolved: ResolvedResearchDemo[] }> {
  const resolved = await inspectOfflinePlanMaterials(authority, runtimes, signal)
  return {
    inspection: {
      source: { ...source, identity: authority.source.identity, title: authority.source.title },
      candidates: resolved.map((result) => result.candidate)
    },
    resolved
  }
}

/** Shared package-plan discovery. Does not require an import or a Replay carrier Session. */
export async function inspectOfflinePlanMaterials(
  authority: ResearchMaterialAuthority,
  runtimes: Awaited<ReturnType<ManagedExecutionService['runtimes']>>,
  signal?: AbortSignal
): Promise<ResolvedResearchDemo[]> {
  const candidates = authority.versions.filter(
    (version) => version.filename === 'research-demo.json'
  )
  if (candidates.length > 32) throw new Error('research-demo-discovery-limit')
  const resolved: ResolvedResearchDemo[] = []
  for (const version of candidates) {
    signal?.throwIfAborted()
    const candidate: ResearchDemoCandidate = {
      demoVersionId: version.versionId,
      title: version.filename,
      status: 'blocked',
      blockers: [],
      substitutions: []
    }
    const result: ResolvedResearchDemo = { candidate }
    resolved.push(result)
    if (version.contentAvailable === false || version.sizeBytes > RESEARCH_DEMO_MAX_BYTES) {
      candidate.blockers.push('invalid-demo')
      continue
    }
    const bytes = await authority.readVersion(version.versionId, {
      maxBytes: RESEARCH_DEMO_MAX_BYTES,
      signal
    })
    if (
      bytes.byteLength !== version.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== version.sha256
    )
      throw new Error('research-demo-content-mismatch')
    const parsed = parseResearchDemoDescription(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
    if (parsed.status !== 'valid') {
      candidate.blockers.push(parsed.status === 'unsupported' ? 'unsupported-demo' : 'invalid-demo')
      continue
    }
    const demo = parsed.description
    result.description = demo
    Object.assign(candidate, {
      title: demo.title,
      description: demo.description,
      planKey: demo.planKey,
      substitutions: demo.substitutions,
      demoViewing: {
        mode: demo.viewing?.mode ?? 'process-lifetime',
        timeoutMs: demo.timeoutMs
      }
    })
    const descriptors = authority.versions.filter(
      (item) =>
        (item.descriptor || item.filename === 'research-reproduction.json') &&
        item.sha256 === demo.descriptorSha256 &&
        item.contentAvailable !== false
    )
    // Identical-content aliases are deterministically selected, never substituted by filename.
    const descriptor = [...descriptors].sort((a, b) => a.versionId.localeCompare(b.versionId))[0]
    if (!descriptor) {
      candidate.blockers.push('descriptor-unavailable')
      continue
    }
    const inspected = await inspectResearchMaterials(authority, {
      descriptorVersionId: descriptor.versionId,
      signal
    })
    const description = inspected.description
    const plan = description?.plans.find((item) => item.key === demo.planKey)
    if (inspected.status !== 'ready' || !description || !plan) {
      candidate.blockers.push('descriptor-unavailable')
      continue
    }
    result.descriptorVersionId = candidate.descriptorVersionId = descriptor.versionId
    result.materialKeys = plan.materialKeys
    result.materialVersions = {}
    for (const key of plan.materialKeys) {
      const material = inspected.materials?.find((item) => item.key === key)
      if (material?.status !== 'available' || !material.versionIds?.length) {
        if (!candidate.blockers.includes('materials-unavailable'))
          candidate.blockers.push('materials-unavailable')
      } else result.materialVersions[key] = [...material.versionIds].sort()[0]
    }
    result.entryPath = entryPath(description, demo)
    if (!result.entryPath) candidate.blockers.push('entrypoint-unavailable')
    if (
      description.secrets?.some((secret) => secret.required && secret.planKeys.includes(plan.key))
    )
      candidate.blockers.push('secrets-required')
    result.runtimeId = runtimes.runtimes.find(
      (runtime) =>
        runtime.platform === 'darwin' &&
        (!plan.requirements?.platforms || plan.requirements.platforms.includes(runtime.platform)) &&
        (!plan.requirements?.node ||
          (validRange(plan.requirements.node) !== null &&
            satisfies(runtime.version, plan.requirements.node)))
    )?.runtimeId
    if (!result.runtimeId) candidate.blockers.push('runtime-unavailable')
    if (demo.localServicePort !== undefined && !runtimes.diagnostics?.nativeServiceSupported)
      candidate.blockers.push('service-unavailable')
    candidate.status = candidate.blockers.length ? 'blocked' : 'ready'
  }
  return resolved
}

/** Literal argv, not caller-supplied shell source. The runtime/path prefix is Main-owned. */
export function researchDemoCommand(demo: ResolvedResearchDemo): string {
  if (!demo.entryPath || !demo.description || demo.candidate.status !== 'ready')
    throw new Error('research-demo-not-ready')
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
  return (
    'node "$OPEN_SCIENCE_INPUT_DIR"/' +
    quote(demo.entryPath) +
    demo.description.arguments.map((argument) => ' ' + quote(argument)).join('')
  )
}
