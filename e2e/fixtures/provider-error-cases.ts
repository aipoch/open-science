import type { FailureReason } from '../../src/shared/failure/contract'

export type ErrorProtocol = 'chat-completions' | 'responses' | 'messages'
export type ProviderErrorCase = Readonly<{
  id: string
  name: string
  status?: number
  code?: string
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

/** 覆盖方案中全部业务错误类型，以及状态、响应结构和流结束的关键分支。 */
export const providerErrorCases: readonly ProviderErrorCase[] = [
  {
    id: 'E01',
    name: '400 模型不可用',
    status: 400,
    code: 'model_unavailable',
    message: 'Model is unavailable',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E02',
    name: '404 模型不存在',
    status: 404,
    code: 'model_not_found',
    message: 'Model retired.v1 does not exist',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E03',
    name: '404 接口路径错误',
    status: 404,
    message: 'Endpoint /v1/wrong not found',
    reason: 'configuration/endpoint-invalid'
  },
  {
    id: 'E04',
    name: '404 无法确定资源类型',
    status: 404,
    message: 'Resource not found',
    reason: 'service/provider-error'
  },
  {
    id: 'E05',
    name: '401 认证失败',
    status: 401,
    code: 'authentication_error',
    message: 'Invalid API key',
    reason: 'configuration/auth-failed'
  },
  {
    id: 'E06',
    name: '403 无访问权限',
    status: 403,
    code: 'permission_denied',
    message: 'Access denied',
    reason: 'configuration/auth-failed'
  },
  {
    id: 'E07',
    name: '429 请求限流',
    status: 429,
    code: 'rate_limit_exceeded',
    message: 'Too many requests',
    reason: 'service/rate-limited'
  },
  {
    id: 'E08',
    name: '429 额度不足',
    status: 429,
    code: 'insufficient_quota',
    message: 'Quota exhausted',
    reason: 'configuration/billing'
  },
  {
    id: 'E09',
    name: '400 普通参数错误',
    status: 400,
    message: 'Invalid temperature',
    reason: 'configuration/request-invalid'
  },
  {
    id: 'E10',
    name: '422 普通参数错误',
    status: 422,
    message: 'Invalid output format',
    reason: 'configuration/request-invalid'
  },
  {
    id: 'E11',
    name: '413 输入或上下文超限',
    status: 413,
    code: 'context_length_exceeded',
    message: 'Maximum context length exceeded',
    reason: 'input/context-overflow'
  },
  {
    id: 'E12',
    name: '500 服务端故障',
    status: 500,
    code: 'server_error',
    message: 'Model service unavailable',
    reason: 'service/unavailable'
  },
  {
    id: 'E13',
    name: '503 HTML 网关错误页',
    status: 503,
    wire: 'html',
    reason: 'service/unavailable'
  },
  {
    id: 'E14',
    name: '400 纯文本模型错误',
    status: 400,
    wire: 'plain',
    message: 'Model is unavailable',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E15',
    name: '200 非 SSE JSON 错误',
    status: 200,
    wire: 'non-sse',
    code: 'model_unavailable',
    message: 'Model is unavailable',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E16',
    name: 'SSE JSON 无法解析',
    wire: 'invalid-json',
    reason: 'service/response-invalid'
  },
  {
    id: 'E17',
    name: 'SSE 缺少正常结束标识',
    wire: 'missing-finish',
    reason: 'service/response-invalid'
  },
  {
    id: 'E18',
    name: 'SSE 未知服务商错误',
    wire: 'sse-error',
    code: 'new_provider_error',
    message: 'Provider rejected this request',
    reason: 'service/provider-error'
  },
  { id: 'E19', name: '上游连接建立失败', wire: 'disconnect', reason: 'service/connection-failed' },
  {
    id: 'E20',
    name: '正文输出后网络中断',
    wire: 'interrupt',
    reason: 'service/response-interrupted'
  },
  {
    id: 'E21',
    name: '400 空错误正文',
    status: 400,
    wire: 'empty',
    reason: 'service/provider-error'
  },
  {
    id: 'E22',
    name: '超长错误消息仅供内部识别',
    status: 422,
    message: 'Invalid parameter: ' + 'x'.repeat(600),
    reason: 'configuration/request-invalid'
  },
  {
    id: 'E23',
    name: 'JSON 正文恰好 16 KiB',
    status: 400,
    wire: 'body-limit',
    message: 'Model is unavailable at byte limit',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E24',
    name: 'JSON 正文超过 16 KiB',
    status: 400,
    wire: 'body-overflow',
    reason: 'service/provider-error'
  },
  {
    id: 'E25',
    name: '错误正文不结束',
    status: 503,
    wire: 'body-timeout',
    reason: 'service/unavailable'
  },
  {
    id: 'E26',
    name: '上游真实 502 不得冒充本机连接失败',
    status: 502,
    wire: 'spoofed-connection',
    message: 'Upstream gateway unavailable',
    reason: 'service/unavailable'
  },
  {
    id: 'E27',
    name: '已知错误的 message 含敏感文本',
    status: 400,
    code: 'model_unavailable',
    message: 'private account and token must not escape',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E28',
    name: '未知错误码和敏感 message 均不得外传',
    status: 400,
    code: 'unknown_private_code',
    message: 'private account and token must not escape',
    reason: 'service/provider-error'
  },
  {
    id: 'E29',
    name: '非法请求标识头被丢弃',
    status: 400,
    code: 'model_unavailable',
    requestId: 'private account and token must not escape',
    reason: 'configuration/model-unavailable'
  },
  {
    id: 'E30',
    name: '超长请求标识头被丢弃',
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
