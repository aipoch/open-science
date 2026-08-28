import {
  RENDERER_API_CONTRACT,
  RENDERER_CONTRACT_CATALOG,
  type OpenScienceAPI,
  type RendererApiContractPath,
  type RendererApiContractValue
} from '../shared/renderer-contract-catalog'
import type { ElectronRendererContractAdapter } from './electron-renderer-contract-adapter'

type ElectronRendererApiOverrides = Partial<{
  [Path in RendererApiContractPath]: RendererApiContractValue<Path>
}>

const descriptorsByPath = new Map(
  RENDERER_CONTRACT_CATALOG.map((descriptor) => [descriptor.publicPath, descriptor] as const)
)

const assignPath = (target: Record<string, unknown>, publicPath: string, value: unknown): void => {
  const parts = publicPath.split('.')
  const member = parts.pop()
  if (!member) throw new Error(`Renderer contract path is empty: ${publicPath}`)

  let parent = target
  for (const part of parts) {
    const current = parent[part]
    if (current === undefined) {
      const nested: Record<string, unknown> = {}
      parent[part] = nested
      parent = nested
      continue
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Renderer contract path collides with a value: ${publicPath}`)
    }
    parent = current as Record<string, unknown>
  }
  if (Object.hasOwn(parent, member)) {
    throw new Error(`Renderer contract path is duplicated: ${publicPath}`)
  }
  parent[member] = value
}

const projectedCallable = (
  publicPath: string,
  adapter: ElectronRendererContractAdapter
): ((...args: unknown[]) => unknown) => {
  const descriptor = descriptorsByPath.get(publicPath)
  if (!descriptor) throw new Error(`Renderer contract has no Electron descriptor: ${publicPath}`)
  if (descriptor.surfaceInstallation.electron !== 'preload') {
    throw new Error(`Renderer contract is not installed in Electron preload: ${publicPath}`)
  }
  if (descriptor.lifecycleDispatch) {
    throw new Error(`Renderer contract requires an Electron lifecycle override: ${publicPath}`)
  }
  if (descriptor.kind === 'event') {
    if (descriptor.dispatchPolicy.electron !== 'electron-ipc-subscription') {
      throw new Error(`Renderer event has no Electron subscription policy: ${publicPath}`)
    }
    return (listener) => adapter.subscribe(publicPath, listener as (payload: unknown) => void)
  }
  if (descriptor.dispatchPolicy.electron === 'electron-ipc-request') {
    return (...args) => adapter.invoke(publicPath, ...args)
  }
  if (descriptor.dispatchPolicy.electron === 'electron-ipc-send') {
    return (...args) => adapter.send(publicPath, ...args)
  }
  throw new Error(`Renderer method requires an Electron native override: ${publicPath}`)
}

export const createElectronRendererApi = (
  adapter: ElectronRendererContractAdapter,
  overrides: ElectronRendererApiOverrides
): OpenScienceAPI => {
  const api: Record<string, unknown> = {}
  for (const publicPath of Object.keys(RENDERER_API_CONTRACT) as RendererApiContractPath[]) {
    const value = Object.hasOwn(overrides, publicPath)
      ? overrides[publicPath]
      : projectedCallable(publicPath, adapter)
    assignPath(api, publicPath, value)
  }
  return api as OpenScienceAPI
}

export type { ElectronRendererApiOverrides }
