import { protocol } from 'electron'
import type { ManagedPreviewResources } from './managed-preview-resources'
import { PREVIEW_SCHEME } from './managed-preview-resources'
import {
  createLoadErrorResponse,
  createManagedPreviewProtocolHandler,
  type ManagedPreviewProtocolOptions
} from './managed-preview-handler'
export { createManagedPreviewProtocolHandler } from './managed-preview-handler'
export type { FetchManagedFile, ManagedPreviewProtocolOptions } from './managed-preview-handler'

type PreviewProtocolRegistrar = Pick<typeof protocol, 'handle' | 'unhandle'>
type ManagedPreviewProtocolBridge = {
  readonly registrar: PreviewProtocolRegistrar
  dispose(): void
}

const registerManagedPreviewProtocol = (
  resources: ManagedPreviewResources,
  targetProtocol: PreviewProtocolRegistrar = protocol,
  options: ManagedPreviewProtocolOptions = {}
): (() => void) => {
  targetProtocol.handle(
    PREVIEW_SCHEME,
    createManagedPreviewProtocolHandler(resources, undefined, options)
  )
  return () => targetProtocol.unhandle(PREVIEW_SCHEME)
}

const createManagedPreviewProtocolBridge = (
  targetProtocol: PreviewProtocolRegistrar
): ManagedPreviewProtocolBridge => {
  type ProtocolHandler = Parameters<PreviewProtocolRegistrar['handle']>[1]
  let delegate: ProtocolHandler | undefined
  let disposed = false

  targetProtocol.handle(PREVIEW_SCHEME, (request) => {
    const handler = delegate
    return handler ? handler(request) : createLoadErrorResponse()
  })

  const assertScheme = (scheme: string): void => {
    if (scheme !== PREVIEW_SCHEME) {
      throw new Error(`Managed preview bridge cannot register scheme: ${scheme}`)
    }
    if (disposed) throw new Error('Managed preview protocol bridge is disposed.')
  }

  return {
    registrar: {
      handle: (scheme, handler) => {
        assertScheme(scheme)
        if (delegate) throw new Error('Managed preview protocol handler is already registered.')
        delegate = handler
      },
      unhandle: (scheme) => {
        assertScheme(scheme)
        delegate = undefined
      }
    },
    dispose: () => {
      if (disposed) return
      delegate = undefined
      targetProtocol.unhandle(PREVIEW_SCHEME)
      disposed = true
    }
  }
}

export { createManagedPreviewProtocolBridge, registerManagedPreviewProtocol }
export type { ManagedPreviewProtocolBridge, PreviewProtocolRegistrar }
