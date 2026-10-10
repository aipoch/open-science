export type RuntimeMetadata = Readonly<{
  version: string
  locale: string
  packaged: boolean
  applicationPath: string
  homePath: string
  downloadsPath: string
  resourcesPath: string
}>

let resolveMetadata: (() => RuntimeMetadata) | undefined

// Bound by the entry point before constructing any business owner. A resolver preserves desktop
// locale changes without exposing Electron's mutable app object to the application graph.
export function configureRuntimeMetadata(resolve: () => RuntimeMetadata): void {
  if (resolveMetadata) throw new Error('Runtime metadata is already configured.')
  resolveMetadata = resolve
  const value = resolve()
  Object.assign(process.env, {
    OPEN_SCIENCE_HOST_HOME: value.homePath,
    OPEN_SCIENCE_APPLICATION_PATH: value.applicationPath,
    OPEN_SCIENCE_RESOURCES_PATH: value.resourcesPath,
    OPEN_SCIENCE_APPLICATION_VERSION: value.version,
    OPEN_SCIENCE_HOST_PACKAGED: value.packaged ? '1' : '0'
  })
}

export function runtimeMetadata(): RuntimeMetadata {
  if (!resolveMetadata) throw new Error('Runtime metadata must be configured by the host entry.')
  return resolveMetadata()
}
