import type { FailureReason } from '../../src/shared/failure/contract'

export type ErrorProtocol = 'chat-completions' | 'responses' | 'messages'
export type ProviderErrorCase = Readonly<{
  id: string
  name: string
  status?: number
  code?: string
  expectedExcerpt?: string
  message?: string
  requestId?: string
  wire?:
    | 'plain'
    | 'html'
    | 'empty'
    | 'non-sse'
    | 'invalid-json'
    | 'missing-finish'
    | 'sse-error'
    | 'disconnect'
    | 'interrupt'
    | 'body-limit'
    | 'body-overflow'
    | 'body-timeout'
    | 'spoofed-connection'
  reason: FailureReason
}>

/** Cover all planned failure reasons and key status, response-shape, and stream-ending branches. */
export const providerErrorCases: readonly ProviderErrorCase[] = [
  {
    id: 'E01',
    name: '400 model unavailable',
    status: 400,
    code: 'model_unavailable',
    message: 'Model is unavailable',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E02',
    name: '404 model not found',
    status: 404,
    code: 'model_not_found',
    message: 'Model retired.v1 does not exist',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E03',
    name: '404 invalid endpoint path',
    status: 404,
    message: 'Endpoint /v1/wrong not found',
    reason: 'configuration/endpoint-invalid'
  },
  {
    id: 'E04',
    name: '404 unspecified resource type',
    status: 404,
    message: 'Resource not found',
    reason: 'service/provider-error'
  },
  {
    id: 'E05',
    name: '401 authentication failed',
    status: 401,
    code: 'authentication_error',
    message: 'Invalid API key for private account',
    expectedExcerpt: 'Invalid API key',
    reason: 'configuration/auth-failed'
  },
  {
    id: 'E06',
    name: '403 permission denied',
    status: 403,
    code: 'permission_denied',
    message: 'Access denied',
    reason: 'configuration/auth-failed'
  },
  {
    id: 'E07',
    name: '429 rate limit exceeded',
    status: 429,
    code: 'rate_limit_exceeded',
    message: 'Too many requests for private account',
    expectedExcerpt: 'Too many requests',
    reason: 'service/rate-limited'
  },
  {
    id: 'E08',
    name: '429 insufficient quota',
    status: 429,
    code: 'insufficient_quota',
    message: 'Quota exhausted',
    reason: 'configuration/billing'
  },
  {
    id: 'E09',
    name: '400 invalid parameter',
    status: 400,
    message: 'Invalid temperature',
    reason: 'configuration/request-invalid'
  },
  {
    id: 'E10',
    name: '422 invalid parameter',
    status: 422,
    message: 'Invalid output format',
    reason: 'configuration/request-invalid'
  },
  {
    id: 'E11',
    name: '413 input exceeds the context limit',
    status: 413,
    code: 'context_length_exceeded',
    message: 'Maximum context length exceeded',
    reason: 'input/context-overflow'
  },
  {
    id: 'E12',
    name: '500 server error',
    status: 500,
    code: 'server_error',
    message: 'Model service unavailable',
    reason: 'service/unavailable'
  },
  {
    id: 'E13',
    name: '503 HTML gateway error page',
    status: 503,
    wire: 'html',
    reason: 'service/unavailable'
  },
  {
    id: 'E14',
    name: '400 plain-text model error',
    status: 400,
    wire: 'plain',
    message: 'Model is unavailable',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E15',
    name: '200 JSON error without an SSE stream',
    status: 200,
    wire: 'non-sse',
    code: 'model_unavailable',
    message: 'Model is unavailable',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E16',
    name: 'Malformed JSON in an SSE event',
    wire: 'invalid-json',
    reason: 'service/response-invalid'
  },
  {
    id: 'E17',
    name: 'SSE stream ends without a completion marker',
    wire: 'missing-finish',
    reason: 'service/response-invalid'
  },
  {
    id: 'E18',
    name: 'Unknown provider error in an SSE event',
    wire: 'sse-error',
    code: 'new_provider_error',
    message: 'Provider rejected this request',
    reason: 'service/provider-error'
  },
  {
    id: 'E19',
    name: 'Upstream connection failed',
    wire: 'disconnect',
    reason: 'service/connection-failed'
  },
  {
    id: 'E20',
    name: 'Connection interrupted after partial output',
    wire: 'interrupt',
    reason: 'service/response-interrupted'
  },
  {
    id: 'E21',
    name: '400 empty response body',
    status: 400,
    wire: 'empty',
    reason: 'service/provider-error'
  },
  {
    id: 'E22',
    name: 'Long error message used only for classification',
    status: 422,
    message: 'Invalid parameter: ' + 'x'.repeat(600),
    reason: 'configuration/request-invalid'
  },
  {
    id: 'E23',
    name: 'JSON body of exactly 16 KiB',
    status: 400,
    wire: 'body-limit',
    message: 'Model is unavailable at byte limit',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E24',
    name: 'JSON body larger than 16 KiB',
    status: 400,
    wire: 'body-overflow',
    reason: 'service/provider-error'
  },
  {
    id: 'E25',
    name: 'Error response body never ends',
    status: 503,
    wire: 'body-timeout',
    reason: 'service/unavailable'
  },
  {
    id: 'E26',
    name: 'Upstream 502 classified as a gateway error',
    status: 502,
    wire: 'spoofed-connection',
    message: 'Upstream gateway unavailable',
    reason: 'service/unavailable'
  },
  {
    id: 'E27',
    name: 'Known error code with a sensitive message',
    status: 400,
    code: 'model_unavailable',
    message: 'private account and token must not escape',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E28',
    name: 'Unknown error code and sensitive message redacted',
    status: 400,
    code: 'unknown_private_code',
    message: 'private account and token must not escape',
    reason: 'service/provider-error'
  },
  {
    id: 'E29',
    name: 'Invalid request ID header discarded',
    status: 400,
    code: 'model_unavailable',
    requestId: 'private account and token must not escape',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E30',
    name: 'Oversized request ID header discarded',
    status: 400,
    code: 'model_unavailable',
    requestId: 'r'.repeat(129),
    reason: 'configuration/model-unavailable'
  }
]

export const partialProviderReply = (protocol: ErrorProtocol): string => {
  const event =
    protocol === 'chat-completions'
      ? {
          choices: [
            {
              index: 0,
              delta: { content: 'Partial response before failure.' },
              finish_reason: null
            }
          ]
        }
      : protocol === 'responses'
        ? { type: 'response.output_text.delta', delta: 'Partial response before failure.' }
        : {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Partial response before failure.' }
          }
  return `data: ${JSON.stringify(event)}\n\n`
}
