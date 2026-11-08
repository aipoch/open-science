export class HuggingFaceJobCreationRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Hugging Face rejected job creation (HTTP ${status}).`)
    this.name = 'HuggingFaceJobCreationRejectedError'
  }
}

export type HuggingFaceJobsConnection = Readonly<{
  namespace: string
  token: string
  signal?: AbortSignal
  fetch?: typeof fetch
}>

export function huggingFaceJobsCollection({ namespace, token }: HuggingFaceJobsConnection): URL {
  if (!/^[\w-]+$/.test(namespace) || !/^[!-~]+$/.test(token))
    throw new Error('A Hugging Face namespace and token are required.')
  return new URL('/api/jobs/' + namespace, 'https://huggingface.co')
}

export function jobsRequestSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(30_000)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

export async function fetchHuggingFaceJob(
  connection: HuggingFaceJobsConnection,
  url: URL,
  action: 'creation' | 'lookup' | 'inspect' | 'cancel' | 'logs',
  signal: AbortSignal,
  body?: string
): Promise<Response> {
  const root = huggingFaceJobsCollection(connection)
  if (
    url.origin !== root.origin ||
    url.username ||
    url.password ||
    url.hash ||
    (url.pathname !== root.pathname && !url.pathname.startsWith(root.pathname + '/'))
  )
    throw new Error('Hugging Face request left the approved Jobs collection.')
  signal.throwIfAborted()
  const response = await (connection.fetch ?? fetch)(url, {
    method: action === 'creation' || action === 'cancel' ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + connection.token,
      Accept: action === 'logs' ? 'text/event-stream' : 'application/json',
      ...(body !== undefined && { 'Content-Type': 'application/json' })
    },
    redirect: 'error',
    signal,
    body
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (action === 'creation' && [400, 401, 402, 403, 404, 413, 415, 422].includes(response.status))
      throw new HuggingFaceJobCreationRejectedError(response.status)
    throw new Error(`Hugging Face job ${action} failed (HTTP ${response.status}).`)
  }
  return response
}
