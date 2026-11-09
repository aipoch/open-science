import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import { RayRequestCredentialError, requestRayDashboard, type RayJobsTarget } from './ray-jobs-http'

export interface RayJobClaim {
  submissionId: string
  entrypoint: string
  workingDir: string
  metadata: Record<string, string>
  cpus: number
  gpus: number
}

export type RayJobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'STOPPED'
export interface RayJobObservation {
  status: RayJobStatus
  exitCode: number | null
}

function rayJobsRequest(
  target: RayJobsTarget,
  path: string,
  init: RequestInit = {},
  onDispatch?: () => void
): Promise<Response> {
  init.signal?.throwIfAborted()
  const deadline = AbortSignal.timeout(30_000)
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
  return requestRayDashboard(target, path, { ...init, signal }, onDispatch)
}

const jsonBudget = 256 * 1024

class RayJobsHttpError extends Error {
  constructor(readonly status: number) {
    super(`Ray Jobs HTTP ${status}`)
  }
}
/** Only the initial POST can produce this result. No request was handed to the transport. */
export class RayJobCreationNotSentError extends Error {}

export class RayJobCreationRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Ray rejected job creation (HTTP ${status}).`)
  }
}

async function readJson(
  response: Response,
  byteLimit = jsonBudget
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new RayJobsHttpError(response.status)
  }
  if (!response.body) throw new Error('Missing Ray Jobs response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > byteLimit) {
        await reader.cancel()
        throw new Error('Ray Jobs response exceeds byte limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Invalid Ray Jobs response')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid Ray Jobs response')
  return parsed as Record<string, unknown>
}

/** Bind approved submissions to the current head session across application restarts. */
export async function inspectRayDashboard(
  target: string | RayJobsTarget,
  signal?: AbortSignal
): Promise<{ sessionName: string; rayVersion: string }> {
  const timeout = AbortSignal.timeout(15_000)
  const info = await readJson(
    await rayJobsRequest(
      typeof target === 'string' ? { endpoint: target } : target,
      '/api/version',
      {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      }
    ),
    16 * 1024
  )
  const { session_name: sessionName, ray_version: rayVersion } = info
  if (
    typeof sessionName !== 'string' ||
    !sessionName.trim() ||
    typeof rayVersion !== 'string' ||
    !rayVersion.trim()
  )
    throw new Error('Invalid Ray Dashboard session identity.')
  return { sessionName, rayVersion }
}

export async function verifyRayJobsAccess(target: RayJobsTarget): Promise<void> {
  await inspectRayDashboard(target)
  // Some gateways expose version metadata while protecting the Jobs API.
  const response = await rayJobsRequest(target, '/api/jobs/')
  await response.body?.cancel()
  if (!response.ok) throw new RayJobsHttpError(response.status)
  if (
    response.status !== 200 ||
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    throw new Error('Unexpected response from the Ray Jobs API.')
}

function jobPath(claim: RayJobClaim): string {
  if (!/^[A-Za-z0-9_-]+$/.test(claim.submissionId)) throw new Error('Invalid Ray submission ID')
  return '/api/jobs/' + claim.submissionId
}

const resourcesKey = 'open_science_entrypoint_resources'

function declaration(claim: RayJobClaim): Record<string, unknown> {
  if (
    Object.hasOwn(claim.metadata, resourcesKey) ||
    Object.values(claim.metadata).some((value) => typeof value !== 'string') ||
    ![claim.cpus, claim.gpus].every((value) => Number.isFinite(value) && value >= 0)
  ) {
    throw new Error('Invalid Ray job declaration')
  }
  return {
    submission_id: claim.submissionId,
    entrypoint: claim.entrypoint,
    runtime_env: { working_dir: claim.workingDir },
    // Ray 2.52 omits entrypoint resource counts from JobDetails; retain the submitted claim.
    metadata: { ...claim.metadata, [resourcesKey]: JSON.stringify([claim.cpus, claim.gpus]) },
    entrypoint_num_cpus: claim.cpus,
    entrypoint_num_gpus: claim.gpus
  }
}

export async function inspectRayJob(
  target: RayJobsTarget,
  claim: RayJobClaim,
  signal?: AbortSignal
): Promise<RayJobObservation> {
  const { entrypoint_num_cpus, entrypoint_num_gpus, ...expectedFields } = declaration(claim)
  const job = await readJson(await rayJobsRequest(target, jobPath(claim), { signal }))
  if (
    job.type !== 'SUBMISSION' ||
    ('entrypoint_num_cpus' in job && job.entrypoint_num_cpus !== entrypoint_num_cpus) ||
    ('entrypoint_num_gpus' in job && job.entrypoint_num_gpus !== entrypoint_num_gpus) ||
    !Object.entries(expectedFields).every(([key, expected]) =>
      isDeepStrictEqual(job[key], expected)
    )
  ) {
    throw new Error('Ray submission declaration mismatch')
  }
  const status = job.status
  if (
    status !== 'PENDING' &&
    status !== 'RUNNING' &&
    status !== 'SUCCEEDED' &&
    status !== 'FAILED' &&
    status !== 'STOPPED'
  ) {
    throw new Error('Unknown Ray job status')
  }
  const code = job.driver_exit_code
  if (code != null && (typeof code !== 'number' || !Number.isSafeInteger(code)))
    throw new Error('Invalid Ray exit code')
  return { status, exitCode: code ?? null }
}

/** Call once per new attempt. Recover an uncertain attempt with inspectRayJob. */
export async function submitRayJob(
  target: RayJobsTarget,
  claim: RayJobClaim,
  signal?: AbortSignal
): Promise<RayJobObservation> {
  target = { ...target }
  claim = { ...claim, metadata: { ...claim.metadata } }
  jobPath(claim)
  if (!claim.entrypoint.trim() || !/^gcs:\/\/_ray_pkg_[0-9a-f]{64}\.zip$/.test(claim.workingDir))
    throw new Error('Invalid Ray submission')
  const body = JSON.stringify(declaration(claim))
  let dispatched = false
  try {
    const receipt = await readJson(
      await rayJobsRequest(
        target,
        '/api/jobs/',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal
        },
        () => {
          dispatched = true
        }
      )
    )
    if (receipt.submission_id !== claim.submissionId)
      throw new Error('Ray submission receipt mismatch')
  } catch (error) {
    if (!dispatched)
      throw new RayJobCreationNotSentError(
        error instanceof RayRequestCredentialError
          ? error.message
          : signal?.aborted
            ? 'Ray submission cancelled before dispatch.'
            : 'Ray submission was not sent.'
      )
    // A gateway can reject both POST and GET. Its explicit denial of this POST is definitive.
    if (error instanceof RayJobsHttpError && (error.status === 401 || error.status === 403))
      throw new RayJobCreationRejectedError(error.status)
    signal?.throwIfAborted()
    // The server may have committed before the response was lost.
    try {
      return await inspectRayJob(target, claim, signal)
    } catch (recoveryError) {
      signal?.throwIfAborted()
      if (
        error instanceof RayJobsHttpError &&
        [400, 402, 404, 413, 415, 422].includes(error.status) &&
        recoveryError instanceof RayJobsHttpError &&
        recoveryError.status === 404
      )
        throw new RayJobCreationRejectedError(error.status)
      throw new AggregateError(
        [error, recoveryError],
        'Ray submission unconfirmed; inspect the existing ID'
      )
    }
  }
  return inspectRayJob(target, claim, signal)
}

export async function stopRayJob(
  target: RayJobsTarget,
  claim: RayJobClaim,
  signal?: AbortSignal
): Promise<RayJobObservation> {
  target = { ...target }
  claim = { ...claim, metadata: { ...claim.metadata } }
  const bounded = AbortSignal.timeout(30_000)
  const until = signal ? AbortSignal.any([signal, bounded]) : bounded
  let observation = await inspectRayJob(target, claim, until)
  if (observation.status !== 'PENDING' && observation.status !== 'RUNNING') return observation
  await readJson(
    await rayJobsRequest(target, jobPath(claim) + '/stop', { method: 'POST', signal: until })
  )
  for (;;) {
    observation = await inspectRayJob(target, claim, until)
    if (observation.status !== 'PENDING' && observation.status !== 'RUNNING') return observation
    await delay(250, undefined, { signal: until })
  }
}

/** The byte budget applies to the full JSON response, including JSON escaping. */
export async function readRayJobLogs(
  target: RayJobsTarget,
  claim: RayJobClaim,
  byteLimit: number,
  signal?: AbortSignal
): Promise<string> {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 16 * 1024 * 1024)
    throw new Error('Invalid Ray log byte limit')
  target = { ...target }
  const path = jobPath(claim) + '/logs'
  await inspectRayJob(target, claim, signal)
  const result = await readJson(await rayJobsRequest(target, path, { signal }), byteLimit)
  if (typeof result.logs !== 'string') throw new Error('Invalid Ray logs')
  return result.logs
}
