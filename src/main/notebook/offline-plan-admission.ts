import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { ResearchMaterialAuthority } from './research-materials'
import {
  executeOfflinePlanRequestSchema,
  inspectOfflinePlansRequestSchema,
  type ExecuteOfflinePlanRequest,
  type OfflinePlanInspection
} from '../../shared/offline-execution'
import {
  executeManagedEnvironmentRequestSchema,
  prepareManagedEnvironmentRequestSchema
} from '../../shared/managed-execution'
import { runObservationDemoViewingAdmissionSchema } from '../../shared/run-observation'
import {
  inspectOfflinePlanMaterials,
  researchDemoCommand,
  type ResolvedResearchDemo
} from '../research-demos/inspection'
import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'
import type {
  ManagedExecutionService,
  ManagedExecutionServiceDependencies
} from './managed-execution-service'

const sha = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const admissionSchema = z
  .object({
    request: executeOfflinePlanRequestSchema,
    operationId: z.string().optional(),
    environmentId: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    prepare: prepareManagedEnvironmentRequestSchema,
    execution: z
      .object(executeManagedEnvironmentRequestSchema.shape)
      .omit({ environmentId: true })
      .strict(),
    options: z
      .object({
        inputVersionIds: z.array(z.string()).min(1),
        demoViewing: runObservationDemoViewingAdmissionSchema
      })
      .strict()
  })
  .strict()
type Admission = z.infer<typeof admissionSchema>
type PreparedOfflinePlan = {
  request: z.output<typeof executeManagedEnvironmentRequestSchema>
  options: Admission['options']
}
type Dependencies = Pick<
  ManagedExecutionServiceDependencies,
  'dataRoot' | 'materials' | 'withWritableSession'
> & {
  service: Pick<ManagedExecutionService, 'runtimes' | 'prepare'>
}

/** Main derives a fixed executable request; callers can only select a published plan Version. */
export class OfflinePlanAdmission {
  private pending = new Map<string, { fingerprint: string; promise: Promise<Admission> }>()
  private preparations = new Map<
    string,
    { fingerprint: string; promise: Promise<PreparedOfflinePlan> }
  >()
  constructor(private readonly dependencies: Dependencies) {}

  private async resolve(
    value: unknown,
    signal?: AbortSignal
  ): Promise<{ source: ResearchMaterialAuthority['source']; resolved: ResolvedResearchDemo[] }> {
    const request = inspectOfflinePlansRequestSchema.parse(value)
    return this.dependencies.withWritableSession(request, async () => {
      signal?.throwIfAborted()
      const authorityRequest = {
        projectId: request.projectId,
        targetSessionId: request.sessionId,
        sourceSessionId: request.sourceSessionId,
        expectedSourceIdentity: request.sourceIdentity,
        signal
      }
      const authority = await this.dependencies.materials(authorityRequest)
      if (
        authority.source.projectId !== request.projectId ||
        authority.source.sessionId !== request.sourceSessionId ||
        (request.sourceIdentity && authority.source.identity !== request.sourceIdentity)
      )
        throw new Error('The selected offline research source changed.')
      const resolved = await inspectOfflinePlanMaterials(
        authority,
        await this.dependencies.service.runtimes(),
        signal
      )
      await this.dependencies.materials({
        ...authorityRequest,
        expectedSourceIdentity: authority.source.identity
      })
      return { source: authority.source, resolved }
    })
  }

  async inspect(value: unknown, signal?: AbortSignal): Promise<OfflinePlanInspection> {
    const { source, resolved } = await this.resolve(value, signal)
    return {
      source,
      confinement: 'offline-project-process',
      plans: resolved.map(({ candidate, description, runtimeId }) => {
        const { demoVersionId, ...view } = candidate
        return {
          ...view,
          planVersionId: demoVersionId,
          ...(runtimeId ? { runtimeId } : {}),
          ...(description
            ? {
                entrypoint: description.entrypoint,
                outputs: description.outputs,
                timeoutMs: description.timeoutMs
              }
            : {}),
          hasProjectView: Boolean(description?.projectView)
        }
      })
    }
  }

  private async admit(
    request: ExecuteOfflinePlanRequest,
    operationId?: string,
    signal?: AbortSignal
  ): Promise<Admission> {
    const key = sha([request.projectId, request.sessionId, operationId ?? null, request.requestId])
    const fingerprint = sha([request, operationId ?? null])
    const active = this.pending.get(key)
    if (active) {
      if (active.fingerprint !== fingerprint)
        throw new Error('Offline plan request conflicts with its earlier contents.')
      return active.promise
    }
    const promise = this.dependencies.withWritableSession(request, async () => {
      const path = join(this.dependencies.dataRoot, 'offline-plan-admissions', key + '.json')
      const stored = await readDurableJsonFile(
        path,
        (text) => admissionSchema.parse(JSON.parse(text)),
        {},
        { maxBytes: 256 * 1024 }
      )
      if (stored.status === 'found') {
        if (sha([stored.value.request, stored.value.operationId ?? null]) !== fingerprint)
          throw new Error('Offline plan request conflicts with its earlier contents.')
        return stored.value
      }
      const { resolved } = await this.resolve(
        {
          projectId: request.projectId,
          sessionId: request.sessionId,
          sourceSessionId: request.sourceSessionId,
          sourceIdentity: request.sourceIdentity
        },
        signal
      )
      const selected = resolved.find(
        (entry) => entry.candidate.demoVersionId === request.planVersionId
      )
      if (
        !selected?.description ||
        selected.candidate.status !== 'ready' ||
        !selected.descriptorVersionId ||
        !selected.runtimeId ||
        !selected.materialKeys ||
        !selected.materialVersions
      )
        throw new Error(
          'The selected offline plan is unavailable. Inspect its blockers before running it.'
        )
      const demo = selected.description
      const admission = admissionSchema.parse({
        request,
        ...(operationId ? { operationId } : {}),
        prepare: {
          projectId: request.projectId,
          sessionId: request.sessionId,
          requestId: 'offline-prepare-' + key,
          sourceSessionId: request.sourceSessionId,
          sourceIdentity: request.sourceIdentity,
          runtimeId: selected.runtimeId,
          materials: {
            descriptorVersionId: selected.descriptorVersionId,
            materialKeys: selected.materialKeys,
            materialVersions: selected.materialVersions
          }
        },
        execution: {
          projectId: request.projectId,
          sessionId: request.sessionId,
          requestId: request.requestId,
          command: researchDemoCommand(selected),
          timeoutMs: demo.timeoutMs,
          outputs: demo.outputs,
          localServicePort: demo.localServicePort,
          projectView: demo.projectView,
          recordObservation: true,
          description:
            'Run the selected offline plan in this Session. This is a new execution under the declared substitutions, not the original research.\n' +
            demo.substitutions.join('\n').slice(0, 15000)
        },
        options: {
          inputVersionIds: [request.planVersionId],
          demoViewing: {
            mode: demo.viewing?.mode ?? 'process-lifetime',
            timeoutMs: demo.timeoutMs
          }
        }
      })
      signal?.throwIfAborted()
      await writeDurableJsonFile(path, JSON.stringify(admission))
      return admission
    })
    this.pending.set(key, { fingerprint, promise })
    try {
      return await promise
    } finally {
      this.pending.delete(key)
    }
  }

  async prepare(
    value: unknown,
    operationId?: string,
    signal?: AbortSignal
  ): Promise<PreparedOfflinePlan> {
    const request = executeOfflinePlanRequestSchema.parse(value)
    const key = sha([request.projectId, request.sessionId, operationId ?? null, request.requestId])
    const fingerprint = sha([request, operationId ?? null])
    const previous = this.preparations.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error('Offline plan request conflicts with its earlier contents.')
      return previous.promise
    }
    const promise = this.dependencies.withWritableSession(request, () =>
      this.prepareOnce(request, key, operationId, signal)
    )
    this.preparations.set(key, { fingerprint, promise })
    try {
      return await promise
    } finally {
      this.preparations.delete(key)
    }
  }

  private async prepareOnce(
    request: ExecuteOfflinePlanRequest,
    key: string,
    operationId?: string,
    signal?: AbortSignal
  ): Promise<PreparedOfflinePlan> {
    const admission = await this.admit(request, operationId, signal)
    signal?.throwIfAborted()
    await this.dependencies.materials({
      projectId: request.projectId,
      targetSessionId: request.sessionId,
      sourceSessionId: request.sourceSessionId,
      expectedSourceIdentity: request.sourceIdentity,
      signal
    })
    if (!admission.environmentId) {
      // A lost preparation reply retries the existing stable preparation request. Once committed,
      // retries do not prepare again (the original operation may be active or already released).
      const prepared = z
        .object({ environmentId: z.string().regex(/^[a-f0-9]{64}$/u) })
        .parse(await this.dependencies.service.prepare(admission.prepare, signal))
      admission.environmentId = prepared.environmentId
      await writeDurableJsonFile(
        join(this.dependencies.dataRoot, 'offline-plan-admissions', key + '.json'),
        JSON.stringify(admission)
      )
    }
    return {
      request: executeManagedEnvironmentRequestSchema.parse({
        ...admission.execution,
        environmentId: admission.environmentId
      }),
      options: admission.options
    }
  }
}
