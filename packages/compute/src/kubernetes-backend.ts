import { createKubernetesRequest, KubernetesBackendError } from './kubernetes-api'
export { KubernetesBackendError } from './kubernetes-api'
import {
  createKubernetesWorkspaces,
  type KubernetesBackendAdapter,
  type KubernetesWorkspace
} from './kubernetes-workspace'
export type { KubernetesBackendAdapter, KubernetesWorkspace } from './kubernetes-workspace'
import { assertComputeBackendCanSubmit } from './backend'
import type {
  ComputeBackendCancellation,
  ComputeBackendCleanup,
  ComputeBackendHandle,
  ComputeBackendHarvest,
  ComputeBackendLogChunk,
  ComputeBackendObservation,
  ComputeBackendSubmissionRequest,
  ComputeBackendTarget,
  ComputeBackendValidation
} from './backend'

const BACKEND_ID = 'kubernetes'
const LAUNCH_ANNOTATION = 'open-science.io/launch-token'
const DEFAULT_LOG_TAIL_LINES = 2_000

type KubernetesMetadata = Readonly<{
  annotations?: Record<string, string>
  name?: string
  uid?: string
}>

type KubernetesJob = Readonly<{
  metadata?: KubernetesMetadata
  spec?: { selector?: { matchLabels?: Record<string, string> } }
  status?: Readonly<{
    ready?: number
    succeeded?: number
    failed?: number
    conditions?: ReadonlyArray<Readonly<{ type?: string; status?: string; reason?: string }>>
  }>
}>

type KubernetesPod = Readonly<{
  metadata?: KubernetesMetadata & {
    deletionTimestamp?: string
    ownerReferences?: ReadonlyArray<{ kind: string; uid: string; controller?: boolean }>
  }
  status?: { conditions?: ReadonlyArray<{ type: string; status: string }> }
}>
const controllerLabels = ['batch.kubernetes.io/controller-uid', 'controller-uid'] as const

const ownedByJob = (pod: KubernetesPod, uid: string): boolean =>
  pod.metadata?.ownerReferences?.some(
    (ref) => ref.kind === 'Job' && ref.uid === uid && ref.controller === true
  ) === true

export type KubernetesFetch = (input: string, init?: RequestInit) => Promise<Response>

export type KubernetesBackendOptions = Readonly<{
  endpoint: string
  namespace: string
  image: string
  headers?: HeadersInit
  fetch?: KubernetesFetch
  logTailLines?: number
}>

const encodePath = (value: string): string => encodeURIComponent(value)

const jobPath = (namespace: string, name?: string): string =>
  `/apis/batch/v1/namespaces/${encodePath(namespace)}/jobs${name ? `/${encodePath(name)}` : ''}`

const namespacePath = (namespace: string): string => `/api/v1/namespaces/${encodePath(namespace)}`

const podLogPath = (namespace: string, podName: string, tailLines: number): string =>
  `/api/v1/namespaces/${encodePath(namespace)}/pods/${encodePath(podName)}/log?tailLines=${tailLines}`

const safeJobName = (jobId: string): string => {
  const lower = jobId.toLowerCase()
  const start = lower.search(/[a-z0-9]/)
  if (start === -1) return 'open-science-job'
  const suffix = lower.slice(start, start + 48).replace(/[^a-z0-9-]/g, '-')
  let end = suffix.length
  while (suffix[end - 1] === '-') end--
  return `open-science-${suffix.slice(0, end)}`
}

const asJob = (value: unknown): KubernetesJob =>
  typeof value === 'object' && value !== null ? (value as KubernetesJob) : {}

const parseHandle = (
  handle: ComputeBackendHandle,
  namespace: string
): { namespace: string; name: string; uid: string } => {
  if (handle.backendId !== BACKEND_ID)
    throw new Error(`Unsupported backend handle: ${handle.backendId}.`)
  let value: unknown
  try {
    value = JSON.parse(handle.value)
  } catch {
    throw new Error('Kubernetes backend handle is malformed.')
  }
  const identity = value as Partial<Record<'name' | 'namespace' | 'uid', unknown>> | null
  if (
    identity?.namespace !== namespace ||
    typeof identity.name !== 'string' ||
    !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(identity.name) ||
    typeof identity.uid !== 'string' ||
    !/^[A-Za-z0-9-]+$/.test(identity.uid)
  )
    throw new Error('Kubernetes backend handle has an invalid namespace, name or UID.')
  return { namespace, name: identity.name, uid: identity.uid }
}

export type KubernetesResourceRequirements = Readonly<{
  requests: Readonly<Record<string, string>>
  limits: Readonly<Record<string, string>>
}>

const parsePositiveInteger = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Kubernetes resource request ${field} must be a positive integer.`)
  }
  return value
}

export const parseKubernetesResourceRequest = (
  value: string | undefined
): KubernetesResourceRequirements | undefined => {
  if (!value?.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Kubernetes resourceRequest must be valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Kubernetes resourceRequest must be a JSON object.')
  }
  const record = parsed as Record<string, unknown>
  const allowed = new Set(['cpus', 'memory_mib', 'gpus'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key))
      throw new Error(`Kubernetes resource request field is unsupported: ${key}.`)
  }
  const cpus = parsePositiveInteger(record.cpus, 'cpus')
  const memoryMib = parsePositiveInteger(record.memory_mib, 'memory_mib')
  const gpus = parsePositiveInteger(record.gpus, 'gpus')
  const requests: Record<string, string> = {}
  if (cpus !== undefined) requests.cpu = String(cpus)
  if (memoryMib !== undefined) requests.memory = `${memoryMib}Mi`
  if (gpus !== undefined) requests['nvidia.com/gpu'] = String(gpus)
  if (Object.keys(requests).length === 0) return undefined
  return { requests, limits: requests }
}

const observationFromJob = (job: KubernetesJob): ComputeBackendObservation => {
  const conditions = job.status?.conditions ?? []
  const complete = conditions.find((condition) => condition.type === 'Complete')
  if (complete?.status === 'True') return { phase: 'succeeded', contact: 'live', exitCode: 0 }

  const failed = conditions.find((condition) => condition.type === 'Failed')
  if (failed?.status === 'True') {
    return {
      phase: 'failed',
      contact: 'live',
      message: failed.reason ?? 'Kubernetes Job failed.'
    }
  }

  // Active includes Pending Pods, including Jobs waiting for a GPU.
  if ((job.status?.ready ?? 0) > 0) return { phase: 'running', contact: 'live' }
  return { phase: 'starting', contact: 'live' }
}

export const createKubernetesBackendAdapter = (
  options: KubernetesBackendOptions
): KubernetesBackendAdapter => {
  const endpoint = options.endpoint.replace(/\/$/, '')
  const namespace = options.namespace.trim()
  const image = options.image.trim()
  const fetchImpl = options.fetch ?? globalThis.fetch
  const logTailLines = options.logTailLines ?? DEFAULT_LOG_TAIL_LINES

  if (!endpoint) throw new Error('Kubernetes endpoint is required.')
  if (!namespace) throw new Error('Kubernetes namespace is required.')
  if (!image) throw new Error('Kubernetes container image is required.')
  if (!fetchImpl) throw new Error('Kubernetes fetch implementation is unavailable.')
  if (!Number.isInteger(logTailLines) || logTailLines <= 0) {
    throw new Error('Kubernetes logTailLines must be a positive integer.')
  }

  const request = createKubernetesRequest(endpoint, fetchImpl, options.headers)

  // Handles outlive Jobs, so logs and cleanup must also recognize the legacy controller label.
  const findPod = async (
    uid: string,
    matches: ((pod: KubernetesPod) => boolean) | undefined,
    signal?: AbortSignal,
    job?: KubernetesJob
  ): Promise<KubernetesPod | undefined> => {
    const selected = controllerLabels.find((key) => job?.spec?.selector?.matchLabels?.[key] === uid)
    for (const label of selected ? [selected] : controllerLabels) {
      const path = `/api/v1/namespaces/${encodePath(namespace)}/pods`
      const query = new URLSearchParams({ labelSelector: label + '=' + uid })
      if (!matches) query.set('limit', '1')
      const response = await request(path + '?' + query, { signal })
      const list = (await response.json()) as { items?: KubernetesPod[] }
      if (!Array.isArray(list.items)) throw new Error('Invalid Kubernetes Pod list.')
      const pod = matches ? list.items.find(matches) : list.items[0]
      if (pod) return pod
    }
    return undefined
  }

  const deleteJob = async (
    handle: ComputeBackendHandle,
    signal?: AbortSignal
  ): Promise<ComputeBackendCancellation> => {
    try {
      const parsed = parseHandle(handle, namespace)
      try {
        await request(jobPath(namespace, parsed.name), {
          method: 'DELETE',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            propagationPolicy: 'Foreground',
            preconditions: { uid: parsed.uid }
          })
        })
        return { outcome: 'requested' }
      } catch (error) {
        if (!(error instanceof KubernetesBackendError && error.status === 404)) throw error
      }
      // A Job can disappear before its Pods when another client deletes it in the background.
      if (await findPod(parsed.uid, undefined, signal))
        return { outcome: 'unknown', message: 'Kubernetes Job Pods still exist.' }
      return { outcome: 'confirmed' }
    } catch (error) {
      return { outcome: 'unknown', message: error instanceof Error ? error.message : String(error) }
    }
  }

  const toHandle = (
    job: KubernetesJob,
    providerId: string,
    expectedNamespace = namespace
  ): ComputeBackendHandle => {
    const name = job.metadata?.name
    if (typeof job.metadata?.uid !== 'string' || !job.metadata.uid)
      throw new Error('Kubernetes API returned a Job without a UID.')
    if (!name) throw new Error('Kubernetes API returned a Job without metadata.name.')
    return {
      backendId: BACKEND_ID,
      providerId,
      value: JSON.stringify({ namespace: expectedNamespace, name, uid: job.metadata?.uid })
    }
  }

  const { prepareWorkspace, releaseWorkspace, withWorkspaceFiles, verifyCurrentClaim } =
    createKubernetesWorkspaces(namespace, request)
  const submit = async (
    submission: ComputeBackendSubmissionRequest,
    signal?: AbortSignal,
    workspace?: KubernetesWorkspace,
    launchToken?: string
  ): Promise<ComputeBackendHandle> => {
    if (submission.target.backendId !== BACKEND_ID) {
      throw new Error(`Expected ${BACKEND_ID} backend.`)
    }
    if (submission.environment?.trim()) {
      throw new Error('Kubernetes backend does not support managed environments yet.')
    }
    if (!workspace) assertComputeBackendCanSubmit({ capabilities }, submission)
    const name = safeJobName(submission.jobId)
    const resources = parseKubernetesResourceRequest(submission.resourceRequest)
    if (workspace) {
      if (
        workspace.jobId !== submission.jobId ||
        workspace.providerId !== submission.target.providerId
      )
        throw new Error('Kubernetes workspace belongs to a different submission.')
      if (submission.workspaceCwd && submission.workspaceCwd !== '/workspace')
        throw new Error('Kubernetes file jobs run in /workspace.')
      await verifyCurrentClaim(workspace, signal)
    }
    const response = await request(jobPath(namespace), {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name,
          labels: { 'open-science-job': name },
          ...(launchToken && { annotations: { [LAUNCH_ANNOTATION]: launchToken } })
        },
        spec: {
          backoffLimit: 0,
          ...(submission.timeoutSeconds
            ? { activeDeadlineSeconds: submission.timeoutSeconds }
            : {}),
          template: {
            metadata: { labels: { 'job-name': name, 'open-science-job': name } },
            spec: {
              restartPolicy: 'Never',
              ...(workspace && {
                automountServiceAccountToken: false,
                volumes: [
                  { name: 'workspace', persistentVolumeClaim: { claimName: workspace.name } }
                ]
              }),
              containers: [
                {
                  name: 'compute',
                  image,
                  command: ['/bin/sh', '-lc', submission.command],
                  ...(workspace
                    ? {
                        workingDir: '/workspace',
                        volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }]
                      }
                    : submission.workspaceCwd
                      ? { workingDir: submission.workspaceCwd }
                      : {}),
                  ...(resources ? { resources } : {})
                }
              ]
            }
          }
        }
      })
    })
    return toHandle(asJob(await response.json()), submission.target.providerId)
  }
  const capabilities = {
    commandExecution: true,
    sourcePackaging: false,
    streamingLogs: true,
    metrics: false,
    cancellation: true,
    outputCollection: false,
    environmentSelection: false
  }
  return {
    id: BACKEND_ID,
    capabilities,
    async validateTarget(
      target: ComputeBackendTarget,
      signal?: AbortSignal
    ): Promise<ComputeBackendValidation> {
      if (target.backendId !== BACKEND_ID) {
        return { valid: false, contact: 'live', message: `Expected ${BACKEND_ID} backend.` }
      }
      try {
        await request(namespacePath(namespace), { signal })
        return { valid: true, contact: 'live' }
      } catch (error) {
        return {
          valid: false,
          contact:
            error instanceof KubernetesBackendError &&
            (error.status === 401 || error.status === 403)
              ? 'needs_auth'
              : error instanceof KubernetesBackendError
                ? 'live'
                : 'unreachable',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    },
    async probe(
      target: ComputeBackendTarget,
      signal?: AbortSignal
    ): Promise<ComputeBackendObservation> {
      const validation = await this.validateTarget(target, signal)
      return {
        phase: 'starting',
        contact: validation.contact,
        ...(validation.message ? { message: validation.message } : {})
      }
    },
    prepareWorkspace,
    withWorkspaceFiles,
    releaseWorkspace,
    submitInWorkspace: (submission, workspace, signal, launchToken) =>
      submit(submission, signal, workspace, launchToken),
    async recoverWorkspaceLaunch(workspace, launchToken, signal) {
      if (!launchToken || workspace.namespace !== namespace)
        throw new Error('Invalid Kubernetes launch reservation.')
      const name = safeJobName(workspace.jobId)
      try {
        const job = asJob(await (await request(jobPath(namespace, name), { signal })).json())
        if (
          job.metadata?.name !== name ||
          job.metadata.annotations?.[LAUNCH_ANNOTATION] !== launchToken
        )
          throw new Error('Kubernetes Job does not match the approved launch.')
        return toHandle(job, workspace.providerId)
      } catch (error) {
        if (error instanceof KubernetesBackendError && error.status === 404) return null
        throw error
      }
    },
    submit: (submission, signal) => submit(submission, signal),
    async recover(
      submission: ComputeBackendSubmissionRequest,
      handle: ComputeBackendHandle,
      signal?: AbortSignal
    ): Promise<ComputeBackendHandle | null> {
      if (submission.target.backendId !== BACKEND_ID) {
        throw new Error(`Expected ${BACKEND_ID} backend.`)
      }
      if (handle.providerId !== submission.target.providerId) {
        throw new Error('Kubernetes backend handle belongs to a different provider.')
      }
      try {
        const parsed = parseHandle(handle, namespace)
        const response = await request(jobPath(parsed.namespace, parsed.name), { signal })
        const job = asJob(await response.json())
        if (parsed.uid !== job.metadata?.uid) {
          throw new Error('Kubernetes Job identity no longer matches the saved handle.')
        }
        return toHandle(job, handle.providerId, parsed.namespace)
      } catch (error) {
        if (error instanceof KubernetesBackendError && error.status === 404) return null
        throw error
      }
    },
    async observe(
      handle: ComputeBackendHandle,
      signal?: AbortSignal
    ): Promise<ComputeBackendObservation> {
      let jobFound = false
      try {
        const parsed = parseHandle(handle, namespace)
        const response = await request(jobPath(parsed.namespace, parsed.name), { signal })
        jobFound = true
        const job = asJob(await response.json())
        if (parsed.uid !== job.metadata?.uid) {
          return {
            phase: 'lost',
            contact: 'live',
            message: 'Kubernetes Job identity no longer matches the saved handle.'
          }
        }
        const observation = observationFromJob(job)
        if (observation.phase !== 'starting' || job.status?.ready !== undefined) return observation
        const readyPod = await findPod(
          parsed.uid,
          (pod) =>
            ownedByJob(pod, parsed.uid) &&
            !pod.metadata?.deletionTimestamp &&
            pod.status?.conditions?.some(
              (condition) => condition.type === 'Ready' && condition.status === 'True'
            ) === true,
          signal,
          job
        )
        return readyPod ? { phase: 'running', contact: 'live' } : observation
      } catch (error) {
        if (!jobFound && error instanceof KubernetesBackendError && error.status === 404) {
          return { phase: 'lost', contact: 'live', message: 'Kubernetes Job no longer exists.' }
        }
        return {
          phase: 'starting',
          contact: 'unreachable',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    },
    cancel: deleteJob,
    async collectLogs(
      handle: ComputeBackendHandle,
      cursor?: string,
      signal?: AbortSignal
    ): Promise<ComputeBackendLogChunk> {
      const parsed = parseHandle(handle, namespace)
      const pod = await findPod(
        parsed.uid,
        (item) => ownedByJob(item, parsed.uid) && !!item.metadata?.name,
        signal
      )
      const podName = pod?.metadata?.name
      if (!podName) return { cursor, stdout: '', stderr: '', complete: false }
      const logsResponse = await request(podLogPath(parsed.namespace, podName, logTailLines), {
        signal,
        // The API server negotiates the log subresource before returning its text stream.
        headers: { Accept: '*/*' }
      })
      return { cursor, stdout: await logsResponse.text(), stderr: '', complete: true }
    },
    async harvest(): Promise<ComputeBackendHarvest> {
      return {
        outcome: 'abandoned',
        message: 'Kubernetes output collection requires an artifact transfer integration.'
      }
    },
    async cleanup(
      handle: ComputeBackendHandle,
      signal?: AbortSignal
    ): Promise<ComputeBackendCleanup> {
      const result = await deleteJob(handle, signal)
      if (result.outcome === 'confirmed') return { outcome: 'cleaned' }
      return {
        outcome: 'unknown',
        message: result.message ?? 'Kubernetes Job deletion is pending.'
      }
    }
  }
}
