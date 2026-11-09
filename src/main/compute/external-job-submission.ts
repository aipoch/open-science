import { getRayToken } from './ray-token'
import { posix } from 'node:path'
import { ComputeHostUnavailableError, type ComputeJob } from '@aipoch/compute'
import { resolveRayJobsEndpoint } from '@aipoch/compute/node'
import { externalComputeMode } from '../../shared/compute'
import type {
  ComputeApprovalRequestInfo,
  KubernetesTarget,
  HostedTarget,
  RayTarget,
  ModalTarget
} from '../../shared/compute'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository, CreateJobRequest } from './job-repository'
import { inspectModalTarget } from './modal-sdk'
import { inspectRayDashboard } from './ray-shared-outputs'
import { getHuggingFaceJobAccess } from './hugging-face-job-access'
import { resolveKubernetesJobTarget } from './kubernetes-kubeconfig'

type Config =
  | { mode: 'kubernetes'; settings: KubernetesTarget }
  | { mode: 'hugging_face_jobs'; settings: HostedTarget }
  | { mode: 'ray_jobs'; settings: RayTarget }
  | { mode: 'modal_sandbox'; settings: ModalTarget }
type Approval = Extract<ComputeApprovalRequestInfo, { operation: 'submit_job' }>
type Files = Pick<NonNullable<Approval['modal']>, 'inputFiles' | 'outputManifest' | 'harvestConfig'>
type Bound = {
  mode: Config['mode']
  workdir: string
  disclosure(files: Files): Pick<Approval, 'kubernetes' | 'hosted' | 'ray' | 'modal'>
  create(repo: ComputeJobRepository, request: CreateJobRequest): Promise<ComputeJob | null>
}

export async function findExternalJobConfig(
  repo: ComputeHostRepository,
  id: string
): Promise<Config | undefined> {
  const mode = externalComputeMode(id)
  if (mode === 'kubernetes') {
    const settings = await repo.getKubernetesTarget(id)
    if (settings) return { mode: 'kubernetes', settings }
  } else if (mode === 'hugging_face_jobs') {
    const settings = await repo.getHostedTarget(id)
    if (settings) return { mode: 'hugging_face_jobs', settings }
  } else if (mode === 'ray_jobs') {
    const settings = await repo.getRayTarget(id)
    if (settings) return { mode: 'ray_jobs', settings }
  } else if (mode === 'modal_sandbox') {
    const settings = await repo.getModalTarget(id)
    if (settings) return { mode: 'modal_sandbox', settings }
  } else return undefined
  throw new ComputeHostUnavailableError()
}

/** Use one snapshot for both the approval dialog and the durable job. SDK credentials never enter it. */
export async function bindExternalJob(
  config: Config,
  jobId: string,
  signal?: AbortSignal
): Promise<Bound> {
  const { mode, settings } = config
  switch (mode) {
    case 'kubernetes': {
      const { context, namespace, image, transferImage, sizeMiB } = settings
      const { endpoint } = await resolveKubernetesJobTarget(context, namespace, image, signal)
      const binding = { context, namespace, image, transferImage, endpoint }
      return {
        mode,
        workdir: '/workspace',
        disclosure: (files) => ({ kubernetes: { ...binding, sizeMiB, ...files } }),
        create: async (repo, request) => {
          await repo.createApprovedKubernetesJob(
            {
              ...request,
              initialStatus: request.initialStatus === 'queued' ? 'queued' : 'submitted'
            },
            binding,
            sizeMiB
          )
          return repo.get(request.id)
        }
      }
    }
    case 'hugging_face_jobs': {
      const { namespace, image, bucket, flavor } = settings
      const { account, rateMicroUsdPerMinute } = await getHuggingFaceJobAccess(settings, signal)
      const details = { namespace, image, bucket, flavor, rateMicroUsdPerMinute }
      return {
        mode,
        workdir: '/outputs',
        disclosure: (files) => ({ hosted: { ...details, runId: jobId, ...files } }),
        create: (repo, request) =>
          repo.createApprovedHuggingFaceJob(request, { ...details, account })
      }
    }
    case 'ray_jobs': {
      const { sharedRoot, remoteRoot, cpus, gpus } = settings
      const endpoint = resolveRayJobsEndpoint(settings.endpoint)
      const { sessionName } = await inspectRayDashboard({ endpoint, getToken: getRayToken }, signal)
      const binding = { endpoint, sessionName, sharedRoot, remoteRoot, cpus, gpus }
      return {
        mode,
        workdir: posix.join(remoteRoot, jobId),
        disclosure: (files) => ({ ray: { ...binding, ...files } }),
        create: (repo, request) => repo.createApprovedRayJob(request, binding)
      }
    }
    case 'modal_sandbox': {
      const { appId } = await inspectModalTarget(settings, signal)
      const { environmentName, appName, image, cpus, memoryMiB, gpu } = settings
      const binding = {
        appId,
        environmentName,
        appName,
        image,
        cpus,
        memoryMiB,
        ...(gpu ? { gpu } : {})
      }
      return {
        mode,
        workdir: '/mnt/openscience/outputs',
        disclosure: (files) => ({ modal: { ...binding, ...files } }),
        create: (repo, request) => repo.createApprovedModalJob(request, binding)
      }
    }
  }
}
