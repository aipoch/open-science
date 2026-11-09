import {
  fetchHuggingFaceJob,
  huggingFaceJobsCollection,
  jobsRequestSignal,
  type HuggingFaceJobsConnection
} from './hugging-face-jobs-http'

type JobRequest = HuggingFaceJobsConnection & Readonly<{ jobId: string }>

type JobPhase = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unreconciled'
type JobInspection = Readonly<{
  id: string
  stage: string
  phase: JobPhase
  message: string | null
  exitCode: number | null
}>

async function jobResponse(
  request: JobRequest,
  action: 'inspect' | 'logs' | 'cancel'
): Promise<Response> {
  if (!/^[\w-]+$/.test(request.jobId))
    throw new Error('A Hugging Face namespace, job ID and token are required.')
  const endpoint = huggingFaceJobsCollection(request)
  endpoint.pathname += '/' + request.jobId
  if (action !== 'inspect') endpoint.pathname += '/' + action
  return fetchHuggingFaceJob(request, endpoint, action, jobsRequestSignal(request.signal))
}

function jobPhase(stage: string): JobPhase {
  switch (stage) {
    case 'SCHEDULING':
      return 'queued'
    case 'RUNNING':
      return 'running'
    case 'COMPLETED':
      return 'succeeded'
    case 'ERROR':
    case 'FAILED':
      return 'failed'
    case 'CANCELED':
    case 'CANCELLED':
      return 'cancelled'
    default:
      // DELETED and unrecognized stages carry no proof of an execution outcome.
      return 'unreconciled'
  }
}

export async function inspectHuggingFaceJob(request: JobRequest): Promise<JobInspection> {
  const response = await jobResponse(request, 'inspect')
  const job = await response.json()
  if (
    job?.id !== request.jobId ||
    (job.owner?.name != null && job.owner.name !== request.namespace) ||
    typeof job.status?.stage !== 'string' ||
    !job.status.stage.trim() ||
    (job.status.message != null && typeof job.status.message !== 'string')
  )
    throw new Error('Invalid Hugging Face job status.')
  const stage: string = job.status.stage
  const phase = jobPhase(stage)
  const message: string | null = job.status.message ?? null
  const code = phase === 'failed' && message?.match(/^Job failed with exit code: (-?\d+)\. Reason:/)
  const parsed = code ? Number(code[1]) : NaN
  return {
    id: request.jobId,
    stage,
    phase,
    message,
    exitCode: phase === 'succeeded' ? 0 : Number.isSafeInteger(parsed) ? parsed : null
  }
}

/** A successful cancellation request still requires a subsequent inspect for the actual outcome. */
export async function cancelHuggingFaceJob(request: JobRequest): Promise<'requested'> {
  const response = await jobResponse(request, 'cancel')
  await response.body?.cancel()
  return 'requested'
}

function logMessage(frame: string): string | undefined {
  const fields = frame.split('\n').filter((line) => line === 'data' || line.startsWith('data:'))
  if (!fields.length) return undefined
  const data = fields.map((line) => line.slice(5).replace(/^ /, '')).join('\n')
  if (data === '') return undefined
  let event
  try {
    event = JSON.parse(data)
  } catch {
    throw new Error('Invalid Hugging Face log event.')
  }
  if (typeof event?.data !== 'string') throw new Error('Invalid Hugging Face log event.')
  if (!event.data.startsWith('===== Job started')) return event.data
}

/** One bounded-time SSE read. On replay, skip the number of log records already consumed. */
export async function* readHuggingFaceJobLogs(
  request: JobRequest & { skip?: number }
): AsyncGenerator<string> {
  let skip = request.skip ?? 0
  if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid Hugging Face log cursor.')
  const response = await jobResponse(request, 'logs')
  if (
    !response.body ||
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream'
  ) {
    await response.body?.cancel()
    throw new Error('Expected a Hugging Face event stream.')
  }
  const reader = response.body.getReader()
  // Buffer only one SSE event. A provider that never terminates a line cannot grow memory.
  const frame = new Uint8Array(256 * 1024)
  const decoder = new TextDecoder()
  let length = 0
  let previousCR = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return // SSE dispatches only complete, blank-line-terminated events.
      request.signal?.throwIfAborted()
      for (const byte of value) {
        const skipLF = previousCR && byte === 10
        previousCR = byte === 13
        if (skipLF) continue
        const newline = previousCR || byte === 10
        if (newline && (length === 0 || frame[length - 1] === 10)) {
          const line = logMessage(decoder.decode(frame.subarray(0, length)))
          length = 0
          if (line !== undefined) {
            if (skip > 0) skip--
            else {
              yield line
              request.signal?.throwIfAborted()
            }
          }
        } else {
          if (length === frame.length)
            throw new Error('Hugging Face log event exceeds the size limit.')
          frame[length++] = newline ? 10 : byte
        }
      }
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}
