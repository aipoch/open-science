import {
  archiveHuggingFaceOutputs,
  listHuggingFaceJobOutputs,
  stageRayJobOutputs,
  type ComputeConnectionLease,
  type FileEntry
} from '@aipoch/compute/node'
import type { ComputeJob } from '../../shared/compute'
import { withHostedPublication } from './hugging-face-job-journal'
import { withRayPublication } from './ray-job-journal'
import { listRayJobOutputs, type RayOutputScope } from './ray-shared-outputs'
import { withModalPublication } from './modal-job-journal'
import { listModalJobOutputs, stageModalJobOutputs, type ModalOutputScope } from './modal-sdk'

export type HarvestSources = {
  workspaceConnection?: ComputeConnectionLease
  hostedOutputs?: { bucket: string; runId: string; token: string }
  rayOutputs?: RayOutputScope
  modalOutputs?: ModalOutputScope
}

export type VolumeFile = FileEntry & { xetHash?: string }
export type PublishedFile = { path: string; bytes: number; sha256: string; xetHash?: string }
export type DiscardedFile = { path: string; bytes: number; xetHash: string }
type StageRequest = {
  files: { path: string; bytes: number; xetHash?: string }[]
  stagingDirectory: string
  maxBytes: number
  signal?: AbortSignal
}
export type HarvestVolume = {
  list(signal?: AbortSignal): Promise<VolumeFile[]>
  stage(request: StageRequest): Promise<readonly (PublishedFile & { localPath: string })[]>
  uri(path: string): string
  publication(files: PublishedFile[], discarded: DiscardedFile[]): string
}

export function resolveHarvestVolume(
  job: ComputeJob,
  sources: HarvestSources
): HarvestVolume | undefined {
  const {
    hostedOutputs: hosted,
    rayOutputs: ray,
    modalOutputs: modal,
    workspaceConnection
  } = sources
  if (
    (job.execution_mode === 'kubernetes') !== Boolean(workspaceConnection) ||
    (job.execution_mode === 'hugging_face_jobs') !== Boolean(hosted) ||
    (job.execution_mode === 'ray_jobs') !== Boolean(ray) ||
    (job.execution_mode === 'modal_sandbox') !== Boolean(modal) ||
    [hosted, ray, modal].some((source) => source && source.runId !== job.job_id)
  )
    throw new Error('Compute harvest source does not match its job.')
  const pathUri = (path: string): string => path.split('/').map(encodeURIComponent).join('/')
  if (hosted)
    return {
      list: async (signal) =>
        (await listHuggingFaceJobOutputs({ ...hosted, signal })).map(
          ({ path, bytes, xetHash }) => ({ path, size_bytes: bytes, xetHash })
        ),
      stage: (request) => archiveHuggingFaceOutputs({ ...hosted, ...request }),
      uri: (path) =>
        'hf://buckets/' +
        hosted.bucket +
        '/open-science/' +
        encodeURIComponent(job.job_id) +
        '/outputs/' +
        pathUri(path),
      publication: (files, discarded) => withHostedPublication(job, files, discarded)
    }
  const jobPath = encodeURIComponent(job.provider_id) + '/' + encodeURIComponent(job.job_id) + '/'
  if (ray)
    return {
      list: (signal) => listRayJobOutputs(ray, signal),
      stage: ({ files, ...options }) =>
        stageRayJobOutputs({
          sharedRoot: ray.sharedRoot,
          submissionId: ray.runId,
          expectedIdentity: ray,
          paths: files.map((f) => f.path),
          ...options
        }),
      uri: (path) => 'ray://' + jobPath + pathUri(path),
      publication: (files) => withRayPublication(job, files)
    }
  if (modal)
    return {
      list: (signal) => listModalJobOutputs(modal, signal),
      stage: (request) => stageModalJobOutputs({ scope: modal, ...request }),
      uri: (path) => 'modal://' + jobPath + pathUri(path),
      publication: (files) => withModalPublication(job, files)
    }
  return undefined
}
