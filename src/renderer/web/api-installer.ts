import { RENDERER_CONTRACT_CATALOG } from '../../shared/renderer-contract-catalog'
import type { RendererContractDescriptor } from '../../shared/renderer-contract'

type Listener = (payload: unknown) => void

type WebRendererAdapters = Readonly<{
  availableRpcChannels: ReadonlySet<string>
  restrictedRpcChannels: ReadonlySet<string>
  invoke: (channel: string, args: unknown[]) => Promise<unknown>
  subscribe: (channel: string, listener: Listener) => () => void
  nativeAdapters: Readonly<Record<string, unknown>>
}>

const assignApiPath = (root: Record<string, unknown>, path: string, value: unknown): void => {
  const parts = path.split('.')
  const key = parts.pop()!
  let target = root
  for (const part of parts) {
    target[part] ??= {}
    target = target[part] as Record<string, unknown>
  }
  target[key] = value
}

const transformArguments = (contract: RendererContractDescriptor, args: unknown[]): unknown[] => {
  switch (contract.parameterCodec.web) {
    case 'default-empty-object':
      return args.length === 0 || (args.length === 1 && args[0] === undefined) ? [{}] : args
    case 'default-empty-object-absent-only':
      return args.length === 0 ? [{}] : args
    case 'storage-parent-object':
      return [{ parent: args[0] }]
    case 'storage-data-root-object':
      return [{ parent: args[0], markOnboarding: args[1] }]
    case 'runtime-selection-object':
      return [{ language: args[0], selection: args[1] }]
    case 'runtime-language-environment-object':
      return [{ language: args[0], envId: args[1] }]
    case 'runtime-language-object':
      return [{ language: args[0] }]
    case 'runtime-enablement-object':
      return [{ language: args[0], envId: args[1], enabled: args[2], force: args[3] }]
    case 'runtime-install-authorization-object':
      return [{ language: args[0], envId: args[1], authorized: args[2] }]
    case 'runtime-interpreter-path-object':
      return [{ language: args[0], path: args[1] }]
    default:
      return args
  }
}

export const installWebRendererContracts = (
  api: Record<string, unknown>,
  adapters: WebRendererAdapters
): void => {
  for (const contract of RENDERER_CONTRACT_CATALOG) {
    const { channel, publicPath } = contract
    if (
      channel !== null &&
      contract.surfaceInstallation.localWeb === 'web-rpc' &&
      adapters.availableRpcChannels.has(channel)
    ) {
      assignApiPath(api, publicPath, (...args: unknown[]) =>
        adapters.invoke(channel, transformArguments(contract, args))
      )
    } else if (
      channel !== null &&
      contract.surfaceInstallation.remoteWeb === 'rejecting-stub' &&
      adapters.restrictedRpcChannels.has(channel)
    ) {
      assignApiPath(api, publicPath, () =>
        Promise.reject(
          new Error(`This action is only available in the local desktop app (${channel}).`)
        )
      )
    } else if (channel !== null && contract.surfaceInstallation.localWeb === 'web-event') {
      assignApiPath(api, publicPath, (listener: Listener) => adapters.subscribe(channel, listener))
    } else if (contract.surfaceInstallation.localWeb === 'browser-native') {
      const nativeAdapter = adapters.nativeAdapters[publicPath]
      if (nativeAdapter !== undefined) assignApiPath(api, publicPath, nativeAdapter)
    }
  }
}
