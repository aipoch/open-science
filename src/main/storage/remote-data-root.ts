import { createRequire } from 'node:module'

type NativePublisherBinding = {
  isRemotePath: (path: string) => boolean
}

const require = createRequire(import.meta.url)
let binding: NativePublisherBinding | undefined

const loadBinding = (): NativePublisherBinding => {
  binding ??= require('@aipoch/safe-file-publisher-native') as NativePublisherBinding
  return binding
}

export const isRemoteWindowsPath = (path: string): boolean => {
  if (process.platform !== 'win32') return false
  return loadBinding().isRemotePath(path)
}
