import type { ModelProtocol } from '@aipoch/providers'

/** Historical settings/checkpoint spelling; never use this type for runtime routing. */
export type StoredModelProtocol = 'anthropic' | 'openai' | 'responses'

export function decodeStoredModelProtocol(value: unknown): ModelProtocol | undefined {
  switch (value) {
    case 'anthropic':
    case 'messages':
      return 'messages'
    case 'openai':
    case 'chat-completions':
      return 'chat-completions'
    case 'responses':
      return 'responses'
    default:
      return undefined
  }
}

export function encodeStoredModelProtocol(value: ModelProtocol): StoredModelProtocol {
  switch (value) {
    case 'messages':
      return 'anthropic'
    case 'chat-completions':
      return 'openai'
    case 'responses':
      return 'responses'
  }
}
