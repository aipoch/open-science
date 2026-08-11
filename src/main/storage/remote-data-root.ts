import { createRequire } from 'node:module'

type NativePublisherBinding = {
  inspectPath: (path: string) => WindowsStoragePathCapabilities
}

export type WindowsStoragePathCapabilities = {
  isRemote: boolean
  supportsHardLinks: boolean
}

const require = createRequire(import.meta.url)
let binding: NativePublisherBinding | undefined

const loadBinding = (): NativePublisherBinding => {
  binding ??= require('@aipoch/safe-file-publisher-native') as NativePublisherBinding
  return binding
}

export const inspectWindowsStoragePath = (path: string): WindowsStoragePathCapabilities => {
  if (process.platform !== 'win32') {
    return { isRemote: false, supportsHardLinks: true }
  }
  return loadBinding().inspectPath(path)
}
