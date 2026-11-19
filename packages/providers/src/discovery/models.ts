import { fetchProviderRequest, readBoundedResponseText, ResponseBodyLimitError } from '../transport'
import { providerErrorDetails } from '../errors'
import {
  CATALOG_EFFORTS,
  type CatalogErrorCode,
  type CatalogField,
  type CatalogMapping,
  type CatalogModel,
  type CatalogRequestOptions
} from '../protocols/catalog'
import type { ModelProtocol, ModelReasoningEffort } from '../protocols/types'

const DEFAULT_LIMITS = {
  modelListResponseBytes: 2 * 1024 * 1024,
  fetchedModels: 2000,
  modelIdCharacters: 512
}
export type ListModelsResult = {
  ok: boolean
  models?: string[]
  catalog?: CatalogModel[]
  status?: number
  message?: string
  code?: CatalogErrorCode
  requestId?: string
}
export type ListModelsTarget = {
  url: string
  vendorId?: string
  key?: string
  options?: CatalogRequestOptions
  parameters?: Readonly<Record<string, string>>
  knownModelIds?: readonly string[]
}
export type ListModelsOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  limits?: Partial<typeof DEFAULT_LIMITS>
}
type ListModelsDeps = ListModelsOptions & { fetchImpl?: typeof fetch }
const at = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node !== null && typeof node === 'object' && Object.hasOwn(node, key)
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value
    )
const fieldValue = (item: unknown, rule: CatalogField): unknown => {
  if (typeof rule === 'string') return at(item, rule)
  const value = at(item, rule.path)
  if (value === undefined || value === null) return undefined
  if ('supportedKeys' in rule)
    return typeof value === 'object'
      ? Object.entries(value)
          .filter(([, v]) => at(v, 'supported') === true)
          .map(([k]) => k)
      : undefined
  const values = Array.isArray(value) ? value : [value]
  return values.some(
    (entry) =>
      typeof entry === 'string' &&
      (entry === rule.includes || (rule.includes === 'image' && entry.startsWith('image/')))
  )
}
const PROTOCOL_PATHS: Record<ModelProtocol, string> = {
  'chat-completions': '/chat/completions',
  responses: '/responses',
  messages: '/messages'
}
const protocols = Object.keys(PROTOCOL_PATHS) as ModelProtocol[]

/** Decode only declared fields; unknown capabilities remain unknown rather than invented defaults. */
const describe = (item: unknown, id: string, fields: CatalogMapping = {}): CatalogModel => {
  const model: CatalogModel = { id }
  for (const [key, rule] of Object.entries(fields)) {
    const value = fieldValue(item, rule)
    if (key === 'efforts') {
      if (Array.isArray(value)) {
        const values = [
          ...new Set(
            value.filter(
              (v): v is ModelReasoningEffort =>
                typeof v === 'string' && CATALOG_EFFORTS.includes(v as ModelReasoningEffort)
            )
          )
        ]
        model.reasoningEffort = values.length ? { supported: true, values } : { supported: false }
      }
    } else if (['contextWindow', 'maxInputTokens', 'maxOutputTokens'].includes(key)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        Object.assign(model, { [key]: value })
    } else if (key.startsWith('supports')) {
      if (typeof value === 'boolean') Object.assign(model, { [key]: value })
    } else if (typeof value === 'string' && value.length <= 512)
      Object.assign(model, { [key]: value })
  }
  if (model.supportsReasoning === false) model.reasoningEffort = { supported: false }
  return model
}
export const parseModelIds = (body: unknown): string[] => {
  const data = at(body, 'data')
  return Array.isArray(data)
    ? data
        .map((entry) => at(entry, 'id'))
        .filter((id): id is string => typeof id === 'string' && id !== '')
    : []
}
class CatalogFailure extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    readonly status?: number,
    readonly requestId?: string
  ) {
    super(message)
  }
}
const httpCode = (status: number): CatalogErrorCode =>
  status === 401
    ? 'authentication'
    : status === 403
      ? 'permission'
      : status === 429
        ? 'rate-limit'
        : status === 404
          ? 'not-found'
          : status >= 500
            ? 'service'
            : 'invalid-response'

/** Execute a complete catalog transaction. No partial page can replace the previous snapshot. */
export const listProviderModels = async (
  target: ListModelsTarget,
  {
    fetchImpl = fetch,
    timeoutMs = 15_000,
    limits: overrides,
    signal: callerSignal
  }: ListModelsDeps = {}
): Promise<ListModelsResult> => {
  const limits = Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([key, value]) => [
      key,
      overrides?.[key as keyof typeof DEFAULT_LIMITS] ?? value
    ])
  ) as typeof DEFAULT_LIMITS
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    Object.values(limits).some((v) => !Number.isSafeInteger(v) || v < 1)
  )
    return {
      ok: false,
      code: 'resource-limit',
      message: 'Invalid model-list resource limits.'
    }
  // Explicit SDK URLs retain their legacy authentication contract; registered catalogs always pass options.
  const options = target.options ?? {
    ...(target.vendorId === 'anthropic' ? { headers: { 'anthropic-version': '2023-06-01' } } : {}),
    auth: {
      header: target.vendorId === 'anthropic' ? 'x-api-key' : 'authorization',
      prefix: target.vendorId === 'anthropic' ? '' : 'Bearer '
    }
  }
  if (target.options && options.auth !== 'none' && options.auth.required !== false && !target.key)
    return { ok: false, code: 'missing-key', message: 'API key is required.' }
  const controller = new AbortController()
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let totalBytes = 0
  let lastStatus: number | undefined
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
  if (options.auth !== 'none' && target.key)
    headers[options.auth.header] = `${options.auth.prefix ?? ''}${target.key}`
  try {
    let address = target.url
    for (const input of options.inputs ?? []) {
      const value = target.parameters?.[input.id]?.trim()
      if (!value && input.required)
        throw new CatalogFailure('missing-parameter', `Missing catalog parameter: ${input.id}.`)
      if (!value) continue
      if (value.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(value))
        throw new CatalogFailure('missing-parameter', `Invalid catalog parameter: ${input.id}.`)
      if (input.location === 'url') address = address.replaceAll(`{${input.id}}`, value)
      else if (input.header) headers[input.header] = value
    }
    const root = new URL(address)
    if (
      !['https:', 'http:'].includes(root.protocol) ||
      root.username ||
      root.password ||
      address.includes('{')
    )
      throw new CatalogFailure('unsupported', 'Invalid model-list URL.')
    const read = async (url: URL): Promise<unknown> => {
      signal.throwIfAborted()
      const response = await fetchProviderRequest(fetchImpl, url.toString(), {
        method: 'GET',
        headers,
        signal
      })
      lastStatus = response.status
      // Read bounded diagnostics, never forward raw JSON/HTML or include request credentials.
      if (!response.ok && !target.options) {
        await response.body?.cancel().catch(() => undefined)
        throw new CatalogFailure(
          httpCode(response.status),
          `Model list request failed (${response.status}).`,
          response.status
        )
      }
      const text = await readBoundedResponseText(
        response,
        limits.modelListResponseBytes,
        'Model list response',
        undefined,
        signal
      )
      totalBytes += new TextEncoder().encode(text).byteLength
      if (totalBytes > 8 * 1024 * 1024)
        throw new CatalogFailure('resource-limit', 'Model list exceeds the total response limit.')
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        if (response.ok)
          throw new CatalogFailure(
            'invalid-response',
            'The vendor returned an invalid model catalog.',
            response.status
          )
      }
      if (!response.ok || (options.successPath && at(body, options.successPath) !== true)) {
        const raw =
          at(body, 'error.message') ??
          at(body, 'message') ??
          (!text.trimStart().startsWith('<') ? text : '')
        const details = providerErrorDetails(
          typeof raw === 'string' ? raw : '',
          target.key ? [target.key] : []
        ).slice(0, 300)
        const requestId =
          response.headers.get('x-request-id') ??
          response.headers.get('request-id') ??
          at(body, 'request_id')
        throw new CatalogFailure(
          httpCode(response.status),
          details || `Model list request failed (${response.status}).`,
          response.status,
          typeof requestId === 'string'
            ? providerErrorDetails(requestId, target.key ? [target.key] : []).slice(0, 128)
            : undefined
        )
      }
      return body
    }
    const catalog = new Map<string, CatalogModel>()
    let rawCount = 0
    let cursor: string | undefined
    let offset = 0
    const seenCursors = new Set<string>()
    for (let page = 1; ; page++) {
      if (page > 20)
        throw new CatalogFailure('resource-limit', 'Model list exceeds the page limit.')
      const url = new URL(root)
      const paging = options.pagination
      if (paging) {
        url.searchParams.set(paging.sizeParameter, String(paging.size))
        if (paging.type === 'cursor') {
          if (cursor) url.searchParams.set(paging.parameter, cursor)
        } else
          url.searchParams.set(paging.parameter, String(paging.type === 'page' ? page : offset))
      }
      const body = await read(url)
      const items = at(body, options.itemsPath ?? 'data')
      if (!Array.isArray(items))
        throw new CatalogFailure(
          'invalid-response',
          'The vendor returned an invalid model catalog.'
        )
      rawCount += items.length
      if (rawCount > limits.fetchedModels)
        throw new CatalogFailure(
          'resource-limit',
          `The vendor returned more than ${limits.fetchedModels} models.`
        )
      for (const item of items) {
        const id = at(item, options.idPath ?? 'id')
        if (
          typeof id !== 'string' ||
          !id.trim() ||
          Array.from(id).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
        )
          throw new CatalogFailure('invalid-response', 'The vendor returned an invalid model ID.')
        if (Array.from(id).length > limits.modelIdCharacters)
          throw new CatalogFailure(
            'resource-limit',
            `The vendor returned a model ID longer than ${limits.modelIdCharacters} characters.`
          )
        if (options.filter && fieldValue(item, options.filter) !== true) continue
        const kiloFree = target.vendorId === 'kilo' ? at(item, 'isFree') === true : undefined
        if (target.vendorId === 'kilo') {
          // The public catalog includes paid and media models. Anonymous access is limited
          // to free text models.
          if (!target.key && !kiloFree) continue
          const outputs = at(item, 'architecture.output_modalities')
          if (!Array.isArray(outputs) || outputs.length !== 1 || outputs[0] !== 'text') continue
        }
        const model = describe(item, id, options.fields)
        if (kiloFree !== undefined) model.supportsAnonymousAccess = kiloFree
        model.source = root.toString()
        if (options.knownModelsOnly && !target.knownModelIds?.includes(id)) model.routes = {}
        if (options.routes) {
          const routes: CatalogModel['routes'] = {}
          const advertised = at(item, options.routes.path)
          for (const protocol of protocols) {
            if (options.routes.type === 'map') {
              const base = at(advertised, `${protocol}.${options.routes.baseUrlPath}`)
              if (typeof base !== 'string') continue
              const parsed = URL.parse(base)
              // A directory cannot redirect runtime credentials to an unrelated origin.
              if (
                !parsed ||
                parsed.origin !== root.origin ||
                parsed.username ||
                parsed.password ||
                parsed.search ||
                parsed.hash
              )
                throw new CatalogFailure(
                  'invalid-response',
                  'The catalog returned an unsafe model route.'
                )
              routes[protocol] = parsed.toString().replace(/\/$/, '')
            } else if (
              Array.isArray(advertised) &&
              advertised.includes(`/api/v1${PROTOCOL_PATHS[protocol]}`)
            ) {
              routes[protocol] = `${root.origin}/api/v1`
            }
          }
          // An explicitly advertised unsupported protocol must never fall back to a guessed route.
          model.routes = routes
        }
        catalog.set(id, model)
      }
      if (!paging) break
      if (paging.type === 'cursor') {
        const more = at(body, paging.morePath)
        if (typeof more !== 'boolean')
          throw new CatalogFailure(
            'invalid-response',
            'The vendor returned invalid pagination metadata.'
          )
        if (!more) break
        const next = at(body, paging.cursorPath)
        if (!items.length || typeof next !== 'string' || !next || seenCursors.has(next))
          throw new CatalogFailure(
            'invalid-response',
            'The vendor returned a repeated or missing page cursor.'
          )
        seenCursors.add(next)
        cursor = next
      } else {
        const total = at(body, paging.totalPath)
        if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < rawCount)
          throw new CatalogFailure(
            'invalid-response',
            'The vendor returned invalid pagination metadata.'
          )
        if (rawCount >= total) break
        if (!items.length)
          throw new CatalogFailure(
            'invalid-response',
            'The model catalog ended before all pages were received.'
          )
        offset += items.length
      }
    }
    if (
      !catalog.size ||
      (options.knownModelsOnly && !target.knownModelIds?.some((id) => catalog.has(id))) ||
      (options.routes &&
        ![...catalog.values()].some((model) => Object.keys(model.routes ?? {}).length))
    )
      throw new CatalogFailure('invalid-response', 'The vendor returned no supported models.')
    if (options.enrichment) {
      // Enrichment cannot expand membership or turn an otherwise complete list into a failure.
      try {
        const body = await read(new URL(options.enrichment.url))
        const items = at(body, options.enrichment.itemsPath)
        if (Array.isArray(items))
          for (const item of items) {
            const id = at(item, 'id')
            const primary = typeof id === 'string' ? catalog.get(id) : undefined
            if (!primary) continue
            const extra = describe(item, primary.id, options.enrichment.fields)
            for (const [field, value] of Object.entries(extra)) {
              if (primary[field as keyof CatalogModel] === undefined)
                Object.assign(primary, { [field]: value })
            }
          }
      } catch {
        // Once the primary list is complete, only caller cancellation should discard it.
        callerSignal?.throwIfAborted()
      }
    }
    const models = [...catalog.values()]
    return { ok: true, models: models.map((m) => m.id), catalog: models, status: 200 }
  } catch (error) {
    if (error instanceof CatalogFailure)
      return {
        ok: false,
        code: error.code,
        status: error.status ?? (target.options ? undefined : lastStatus),
        message: error.message,
        requestId: error.requestId
      }
    if (error instanceof ResponseBodyLimitError)
      return { ok: false, code: 'resource-limit', message: error.message }
    const message =
      !target.options && error instanceof Error
        ? error.message
        : 'Could not load the model catalog.'
    return {
      ok: false,
      code: signal.aborted && !callerSignal?.aborted ? 'timeout' : 'network',
      message:
        !target.options && callerSignal?.aborted && callerSignal.reason instanceof Error
          ? callerSignal.reason.message
          : message
    }
  } finally {
    clearTimeout(timer)
  }
}
