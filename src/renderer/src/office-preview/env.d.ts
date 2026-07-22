import type { OfficePreviewRuntimeBridge } from '../../../preload/office-preview'

declare global {
  interface Window {
    officePreviewRuntime: OfficePreviewRuntimeBridge
  }
}

export {}
