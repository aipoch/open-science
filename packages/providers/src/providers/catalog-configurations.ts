import type { CatalogRequestOptions } from '../protocols/catalog'

// These templates describe wire shapes only. Addresses and opt-in registration stay in data.ts.
export const bearerCatalog: CatalogRequestOptions = {
  auth: { header: 'authorization', prefix: 'Bearer ' }
}
export const publicCatalog: CatalogRequestOptions = { auth: 'none' }
export const anthropicCatalog: CatalogRequestOptions = {
  auth: { header: 'x-api-key' },
  headers: { 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
  inputs: [{ id: 'workspaceId', location: 'header', header: 'anthropic-workspace-id' }],
  pagination: {
    type: 'cursor',
    parameter: 'after_id',
    morePath: 'has_more',
    cursorPath: 'last_id',
    size: 100,
    sizeParameter: 'limit'
  },
  fields: {
    name: 'display_name',
    maxInputTokens: 'max_input_tokens',
    maxOutputTokens: 'max_tokens',
    supportsImageInput: 'capabilities.image_input.supported',
    efforts: { path: 'capabilities.effort', supportedKeys: true },
    lifecycle: 'lifecycle'
  }
}
export const bailianCatalog: CatalogRequestOptions = {
  ...bearerCatalog,
  itemsPath: 'output.models',
  idPath: 'model',
  successPath: 'success',
  pagination: {
    type: 'page',
    parameter: 'page_no',
    sizeParameter: 'page_size',
    size: 20,
    totalPath: 'output.total'
  },
  filter: { path: 'inference_metadata.response_modality', includes: 'Text' },
  fields: {
    name: 'name',
    contextWindow: 'model_info.context_window',
    maxInputTokens: 'model_info.max_input_tokens',
    maxOutputTokens: 'model_info.max_output_tokens',
    supportsImageInput: { path: 'inference_metadata.request_modality', includes: 'Image' },
    supportsTools: { path: 'features', includes: 'function-calling' }
  }
}
export const openCodeCatalog: CatalogRequestOptions = {
  ...publicCatalog,
  filter: { path: 'type', includes: 'chat' },
  routes: { type: 'map', path: 'api', baseUrlPath: 'base_url' },
  fields: {
    name: 'name',
    contextWindow: 'limit.context',
    maxInputTokens: 'limit.input',
    maxOutputTokens: 'limit.output',
    supportsImageInput: { path: 'modalities.input', includes: 'image' },
    supportsTools: 'capabilities.tools.supported',
    supportsReasoning: 'capabilities.reasoning.supported',
    efforts: 'capabilities.reasoning.effort'
  }
}
