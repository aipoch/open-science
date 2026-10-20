import type {
  RendererContractSeed,
  RendererParameterCodec,
  RendererSurfaceProfile
} from '../renderer-contract'
export type RemoveListener = () => void
export type AcpListener<Payload> = (payload: Payload) => void

export const WEB = 'web'
export const LOCAL = 'local'
export const EVENT = 'event'
export const CLOSE_PANE_EVENT = 'close-pane-event'
export const ELECTRON = 'electron'
export const MAPPED_ELECTRON = 'mapped-electron'
export const SEND = 'send'
export const WINDOW_FIND_READY = 'window-find-ready'
export const ELECTRON_EVENT = 'electron-event'
export const NATIVE = 'native'
export const MAPPED_NATIVE = 'mapped-native'
export const DELEGATED_NATIVE = 'delegated-native'

export const POSITIONAL = 'positional'
export const DEFAULT_EMPTY = 'default-empty-object'
export const DEFAULT_EMPTY_ABSENT_ONLY = 'default-empty-object-absent-only'
export const OPTIONAL_ARGUMENT_SLOT = 'optional-argument-slot'
export const STORAGE_PARENT = 'storage-parent-object'
export const STORAGE_ROOT = 'storage-data-root-object'
export const RUNTIME_LANGUAGE_ENV = 'runtime-language-environment-object'
export const RUNTIME_LANGUAGE = 'runtime-language-object'
export const RUNTIME_ENABLEMENT = 'runtime-enablement-object'
export const RUNTIME_INSTALL_AUTH = 'runtime-install-authorization-object'
export const RUNTIME_INTERPRETER = 'runtime-interpreter-path-object'
export const NATIVE_FILE_UPLOAD = 'native-file-upload-request'
export const SESSION_SAVE = 'session-save-optional-argument'
export const SESSION_SAVE_JSON = 'session-save-json-undefined'
export const RUNTIME_VALIDATED = 'runtime-validated'

// prettier-ignore
export type ContractProfile = typeof WEB | typeof LOCAL | typeof EVENT | typeof CLOSE_PANE_EVENT | typeof ELECTRON | typeof MAPPED_ELECTRON | typeof SEND | typeof WINDOW_FIND_READY | typeof ELECTRON_EVENT | typeof NATIVE | typeof MAPPED_NATIVE | typeof DELEGATED_NATIVE

// [channel, surface profile?, Electron codec?, Web codec?, Application command?].
// prettier-ignore
export type ContractMetadata = readonly [channel: string | null, profile?: ContractProfile, electronCodec?: RendererParameterCodec, webCodec?: RendererParameterCodec, applicationCommand?: typeof RUNTIME_VALIDATED]

export type ContractOptions = Readonly<{ optionalRoot?: true; optionalMember?: true }>

export type RendererApiContractDraft<
  Value,
  OptionalRoot extends boolean = false,
  OptionalMember extends boolean = false
> = Readonly<{
  capability: string
  metadata: ContractMetadata | null
  optionalRoot: OptionalRoot
  optionalMember: OptionalMember
  __value?: Value
}>

export const callable =
  <Value extends (...args: never[]) => unknown>() =>
  <const Options extends ContractOptions | undefined = undefined>(
    capability: string,
    metadata: ContractMetadata,
    options?: Options
  ): RendererApiContractDraft<
    Value,
    Options extends { optionalRoot: true } ? true : false,
    Options extends { optionalMember: true } ? true : false
  > =>
    Object.freeze({
      capability,
      metadata,
      optionalRoot: Boolean(options?.optionalRoot) as Options extends { optionalRoot: true }
        ? true
        : false,
      optionalMember: Boolean(options?.optionalMember) as Options extends { optionalMember: true }
        ? true
        : false
    })

export const value =
  <Value>() =>
  (capability: string): RendererApiContractDraft<Value> =>
    Object.freeze({ capability, metadata: null, optionalRoot: false, optionalMember: false })

// prettier-ignore
export const CLOSE_PANE_LIFECYCLE = { activateChannel: 'shortcut:close-active-pane-ready', activate: 'after-subscribe', deactivateChannel: 'shortcut:close-active-pane-unready', deactivate: 'after-unsubscribe' } as const
// prettier-ignore
export const WINDOW_FIND_LIFECYCLE = { activateChannel: 'shortcut:window-find-ready', activate: 'on-call', deactivateChannel: 'shortcut:window-find-unready', deactivate: 'on-dispose' } as const

export const surface = <Value>(
  electron: Value,
  localWeb: Value,
  remoteWeb: Value
): RendererSurfaceProfile<Value> => ({ electron, localWeb, remoteWeb })

export const expandEntry = (
  publicPath: string,
  { capability, metadata }: RendererApiContractDraft<unknown, boolean, boolean>
): RendererContractSeed & { capability: string } => {
  if (metadata === null) {
    throw new Error('Renderer value has no transport descriptor: ' + publicPath)
  }
  const [channel, profile = WEB, electronCodec, webCodec, applicationCommand] = metadata
  const isWebRequest = profile === WEB || profile === LOCAL
  const isWebEvent = profile === EVENT
  const isElectronEvent = profile === ELECTRON_EVENT || profile === CLOSE_PANE_EVENT
  const isNative = profile === NATIVE || profile === MAPPED_NATIVE || profile === DELEGATED_NATIVE
  const kind = isWebEvent || isElectronEvent ? 'event' : 'method'
  const defaultElectronCodec =
    kind === 'event' ? 'event-listener' : profile === NATIVE ? 'surface-native' : POSITIONAL
  const defaultWebCodec = isNative ? 'surface-native' : defaultElectronCodec
  const localInstallation = isWebRequest
    ? 'web-rpc'
    : isWebEvent
      ? 'web-event'
      : isNative
        ? 'browser-native'
        : 'unavailable'
  const localDispatch = isWebRequest
    ? 'direct-application-request'
    : isWebEvent
      ? 'web-event-subscription'
      : profile === DELEGATED_NATIVE
        ? 'browser-native-with-direct-application-request'
        : isNative
          ? 'surface-native'
          : 'none'
  const electronDispatch =
    profile === SEND || profile === WINDOW_FIND_READY
      ? 'electron-ipc-send'
      : kind === 'event'
        ? 'electron-ipc-subscription'
        : profile === NATIVE
          ? 'surface-native'
          : 'electron-ipc-request'

  return {
    capability,
    publicPath,
    channel,
    kind,
    parameterCodec: {
      electron: electronCodec ?? defaultElectronCodec,
      web: webCodec ?? electronCodec ?? defaultWebCodec
    },
    surfaceInstallation: surface(
      'preload',
      localInstallation,
      profile === LOCAL ? 'rejecting-stub' : localInstallation
    ),
    dispatchPolicy: surface(
      electronDispatch,
      localDispatch,
      profile === LOCAL ? 'rejecting-stub' : localDispatch
    ),
    eventDeliverability: surface(
      kind === 'event' ? 'electron-ipc' : 'not-event',
      profile === EVENT ? 'application-event' : kind === 'event' ? 'unavailable' : 'not-event',
      profile === EVENT ? 'application-event' : kind === 'event' ? 'unavailable' : 'not-event'
    ),
    authorityFlow: surface(
      kind === 'event' || profile === NATIVE ? 'none' : 'electron-sender',
      isWebRequest || profile === DELEGATED_NATIVE ? 'caller-context' : 'none',
      profile === WEB || profile === DELEGATED_NATIVE ? 'caller-context' : 'none'
    ),
    applicationCommand,
    lifecycleDispatch:
      profile === CLOSE_PANE_EVENT
        ? CLOSE_PANE_LIFECYCLE
        : profile === WINDOW_FIND_READY
          ? WINDOW_FIND_LIFECYCLE
          : undefined,
    mapProjection:
      isWebRequest ||
      profile === MAPPED_ELECTRON ||
      profile === MAPPED_NATIVE ||
      profile === DELEGATED_NATIVE
        ? 'invoke'
        : isWebEvent
          ? 'event'
          : 'none'
  }
}

export type BivariantCallable<Value> = Value extends (...args: infer Args) => infer Result
  ? { bivarianceHack(...args: Args): Result }['bivarianceHack']
  : Value
export type ContractValue<Draft> =
  Draft extends RendererApiContractDraft<infer Value, boolean, boolean>
    ? BivariantCallable<Value>
    : never
export type ContractOptionalRoot<Draft> =
  Draft extends RendererApiContractDraft<unknown, infer Optional, boolean> ? Optional : false
export type ContractOptionalMember<Draft> =
  Draft extends RendererApiContractDraft<unknown, boolean, infer Optional> ? Optional : false

export type PathObject<
  Path extends string,
  Value,
  OptionalRoot extends boolean,
  OptionalMember extends boolean
> = Path extends `${infer Root}.${infer Rest}`
  ? OptionalRoot extends true
    ? { [Key in Root]?: PathObject<Rest, Value, false, OptionalMember> }
    : { [Key in Root]: PathObject<Rest, Value, false, OptionalMember> }
  : OptionalMember extends true
    ? { [Key in Path]?: Value }
    : { [Key in Path]: Value }

export type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never

export type RendererApiFromContract<
  Contract extends Readonly<Record<string, RendererApiContractDraft<unknown, boolean, boolean>>>
> = {
  [
    Key in keyof UnionToIntersection<
      {
        [Path in keyof Contract & string]: PathObject<
          Path,
          ContractValue<Contract[Path]>,
          ContractOptionalRoot<Contract[Path]>,
          ContractOptionalMember<Contract[Path]>
        >
      }[keyof Contract & string]
    >
  ]: UnionToIntersection<
    {
      [Path in keyof Contract & string]: PathObject<
        Path,
        ContractValue<Contract[Path]>,
        ContractOptionalRoot<Contract[Path]>,
        ContractOptionalMember<Contract[Path]>
      >
    }[keyof Contract & string]
  >[Key]
}

// Preserve insertion order and reject collisions before an assignment can hide them.
export function composeRendererApiContract<
  const Parts extends readonly Readonly<
    Record<string, RendererApiContractDraft<unknown, boolean, boolean>>
  >[]
>(...parts: Parts): Readonly<UnionToIntersection<Parts[number]>> {
  const result: Record<string, RendererApiContractDraft<unknown, boolean, boolean>> = {}
  for (const part of parts) {
    for (const [path, draft] of Object.entries(part)) {
      if (Object.hasOwn(result, path)) throw new Error('Duplicate renderer contract path: ' + path)
      result[path] = draft
    }
  }
  return Object.freeze(result) as Readonly<UnionToIntersection<Parts[number]>>
}
