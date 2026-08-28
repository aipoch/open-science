import type { OpenScienceAPI } from '../shared/renderer-contract-catalog'

declare global {
  interface Window {
    api: OpenScienceAPI
  }
}

export {}
