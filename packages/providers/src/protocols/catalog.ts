import type { ModelProtocol, ModelReasoningEffort, ReasoningCapability } from '../protocols/types'

/** Portable, secret-free catalog values shared by discovery, pickers and runtime routing. */
export type CatalogModel = {
  id: string
  name?: string
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  supportsImageInput?: boolean
  supportsTools?: boolean
  supportsReasoning?: boolean
  supportsAnonymousAccess?: boolean
  reasoningEffort?: ReasoningCapability
  lifecycle?: string
  routes?: Partial<Record<ModelProtocol, string>>
  source?: string
}
export type CatalogErrorCode =
  | 'unsupported'
  | 'missing-key'
  | 'missing-parameter'
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'service'
  | 'not-found'
  | 'network'
  | 'timeout'
  | 'invalid-response'
  | 'resource-limit'
  | 'stale'
export type CatalogStatus = {
  attemptedAt: number
  ok: boolean
  code?: CatalogErrorCode
  status?: number
}
export type CatalogSnapshot = { fetchedAt: number; models: CatalogModel[] }
export type CatalogInput = {
  id: string
  required?: boolean
  location: 'url' | 'header'
  header?: string
}
export type CatalogField =
  string | { path: string; includes: string } | { path: string; supportedKeys: true }
export type CatalogMapping = Partial<
  Record<
    | 'name'
    | 'contextWindow'
    | 'maxInputTokens'
    | 'maxOutputTokens'
    | 'supportsImageInput'
    | 'supportsTools'
    | 'supportsReasoning'
    | 'efforts'
    | 'lifecycle',
    CatalogField
  >
>
export type CatalogPagination =
  | {
      type: 'cursor'
      parameter: string
      morePath: string
      cursorPath: string
      size: number
      sizeParameter: string
    }
  | {
      type: 'page' | 'offset'
      parameter: string
      sizeParameter: string
      size: number
      totalPath: string
    }
export type CatalogRequestOptions = {
  auth: 'none' | { header: string; prefix?: string; required?: false }
  headers?: Readonly<Record<string, string>>
  inputs?: readonly CatalogInput[]
  itemsPath?: string
  idPath?: string
  fields?: CatalogMapping
  pagination?: CatalogPagination
  successPath?: string
  filter?: { path: string; includes: string }
  knownModelsOnly?: boolean
  routes?: { type: 'map'; path: string; baseUrlPath: string } | { type: 'endpoints'; path: string }
  enrichment?: { url: string; itemsPath: string; fields: CatalogMapping }
}
export const CATALOG_EFFORTS: readonly ModelReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]
