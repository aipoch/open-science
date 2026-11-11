import {
  fetchHuggingFaceJob,
  huggingFaceJobsCollection,
  jobsRequestSignal,
  type HuggingFaceJobsConnection
} from './hugging-face-jobs-http'

// Shared by the submitter and recovery so a lost creation response can be reconciled by label.
export const HUGGING_FACE_RUN_LABEL = 'open_science_run'

type RunLookup = HuggingFaceJobsConnection & Readonly<{ runId: string }>

function runLabel(runId: string): string {
  if (!/^[\w-]+$/.test(runId)) throw new Error('Invalid Hugging Face run ID.')
  return runId
}

type BucketMount = Readonly<{ bucket: string; prefix: string }>

type ApprovedSubmission = RunLookup &
  Readonly<{
    image: string
    command: readonly string[]
    flavor: string
    timeoutSeconds: number
    inputs: BucketMount
    outputs: BucketMount
  }>

function volume(
  mount: BucketMount,
  mountPath: string,
  readOnly: boolean
): {
  type: 'bucket'
  source: string
  path: string
  mountPath: string
  readOnly: boolean
} {
  if (
    !/^[\w-]+\/[\w.-]+$/.test(mount.bucket) ||
    mount.bucket.split('/').some((part) => part === '.' || part === '..') ||
    !mount.prefix
      .split('/')
      .every((part) => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..')
  )
    throw new Error('A scoped Hugging Face Bucket path is required.')
  return { type: 'bucket', source: mount.bucket, path: mount.prefix, mountPath, readOnly }
}

/** Issue one create request for an approved spec whose input files are already staged. */
export async function submitHuggingFaceJob(request: ApprovedSubmission): Promise<string> {
  const collection = huggingFaceJobsCollection(request)
  const { image, command, flavor, timeoutSeconds, inputs, outputs } = request
  if (
    !image.trim() ||
    !flavor.trim() ||
    !command.length ||
    !command[0]?.trim() ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1
  )
    throw new Error('Hugging Face jobs require an image, command, flavor and positive timeout.')
  const volumes = [volume(inputs, '/inputs', true), volume(outputs, '/outputs', false)]
  if (
    inputs.bucket === outputs.bucket &&
    (inputs.prefix === outputs.prefix ||
      inputs.prefix.startsWith(outputs.prefix + '/') ||
      outputs.prefix.startsWith(inputs.prefix + '/'))
  )
    throw new Error('Hugging Face input and output directories overlap.')
  // A lost reply may already have created a billable job. Reconcile the label before any retry.
  const response = await fetchHuggingFaceJob(
    request,
    collection,
    'creation',
    jobsRequestSignal(request.signal),
    JSON.stringify({
      dockerImage: image,
      command,
      flavor,
      timeoutSeconds,
      attempts: 1,
      labels: { [HUGGING_FACE_RUN_LABEL]: runLabel(request.runId) },
      volumes
    })
  )
  const job = await response.json()
  if (typeof job?.id !== 'string' || !/^[\w-]+$/.test(job.id))
    throw new Error('Invalid Hugging Face Job creation response.')
  return job.id
}

function nextPage(link: string | null, current: URL): URL | undefined {
  if (!link) return undefined
  // Hub pagination uses RFC 8288 Link entries. A comma inside the target is part of the URL.
  let next: URL | undefined
  for (const entry of link.split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]+)>((?:\s*;[^<>]*)?)\s*$/.exec(entry)
    if (!match) throw new Error('Invalid Hugging Face Jobs pagination.')
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(match[2])
    if ((rel?.[1] ?? rel?.[2])?.split(/\s+/).includes('next')) {
      if (next) throw new Error('Ambiguous Hugging Face Jobs pagination.')
      next = new URL(match[1], current)
    }
  }
  return next
}

/** Returns a candidate id, or null after a complete empty lookup. Never submits a job. */
export async function findHuggingFaceJobForRun(request: RunLookup): Promise<string | null> {
  const runId = runLabel(request.runId)
  const collection = huggingFaceJobsCollection(request)
  const label = HUGGING_FACE_RUN_LABEL + '=' + runId
  const signal = jobsRequestSignal(request.signal)
  const visited = new Set<string>()
  let page: URL | undefined = new URL(collection)
  let candidate: string | null = null
  while (page) {
    signal.throwIfAborted()
    if (
      page.origin !== collection.origin ||
      page.pathname !== collection.pathname ||
      page.username ||
      page.password ||
      page.hash
    )
      throw new Error('Hugging Face pagination left the approved Jobs collection.')
    page.searchParams.set('labels', label)
    if (visited.has(page.href) || visited.size >= 100)
      throw new Error('Incomplete Hugging Face Jobs pagination.')
    visited.add(page.href)
    const response = await fetchHuggingFaceJob(request, page, 'lookup', signal)
    const jobs: unknown = await response.json()
    if (!Array.isArray(jobs)) throw new Error('Invalid Hugging Face Jobs response.')
    for (const job of jobs) {
      if (
        !job ||
        typeof job !== 'object' ||
        typeof job.id !== 'string' ||
        !/^[\w-]+$/.test(job.id) ||
        (job.labels != null && (typeof job.labels !== 'object' || Array.isArray(job.labels)))
      )
        throw new Error('Invalid Hugging Face job record.')
      if (job.labels?.[HUGGING_FACE_RUN_LABEL] !== runId) continue
      if (candidate !== null && candidate !== job.id)
        throw new Error('Multiple Hugging Face jobs match the run label.')
      candidate = job.id
    }
    page = nextPage(response.headers.get('link'), page)
  }
  return candidate
}

// A label locates candidates. Only a job matching the approved payer, invocation and file mounts can be adopted.
export async function recoverApprovedHuggingFaceJob(
  request: ApprovedSubmission
): Promise<string | null> {
  const id = await findHuggingFaceJobForRun(request)
  if (!id) return null
  const url = huggingFaceJobsCollection(request)
  url.pathname += '/' + id
  const response = await fetchHuggingFaceJob(
    request,
    url,
    'inspect',
    jobsRequestSignal(request.signal)
  )
  const job = await response.json()
  const mounts = [
    volume(request.inputs, '/inputs', true),
    volume(request.outputs, '/outputs', false)
  ]
  const sameMounts =
    Array.isArray(job.volumes) &&
    job.volumes.length === 2 &&
    mounts.every((expected) =>
      job.volumes.some(
        (actual: Record<string, unknown>) =>
          actual &&
          Object.entries(expected).every(
            ([key, value]) => (key === 'readOnly' ? (actual[key] ?? false) : actual[key]) === value
          )
      )
    )
  if (
    job.id !== id ||
    job.owner?.name !== request.namespace ||
    job.labels?.[HUGGING_FACE_RUN_LABEL] !== request.runId ||
    job.dockerImage !== request.image ||
    job.flavor !== request.flavor ||
    job.timeoutSeconds !== request.timeoutSeconds ||
    (job.attempts ?? 1) !== 1 ||
    JSON.stringify(job.command) !== JSON.stringify(request.command) ||
    (job.arguments?.length ?? 0) !== 0 ||
    Object.keys(job.environment ?? {}).length ||
    Object.keys(job.secrets ?? {}).length ||
    !sameMounts
  )
    throw new Error('HF job candidate does not match the approved submission.')
  return id
}
