import { DesktopCapabilityUnavailable } from '../desktop-interaction'
import { runtimeMetadata } from '../runtime-metadata'
import type { createUpdateStrategy } from './create-strategy'
import type { UpdateStrategy } from './strategy'

let createDesktopStrategy: typeof createUpdateStrategy | undefined
export function configureDesktopUpdateStrategy(factory: typeof createUpdateStrategy): void {
  if (createDesktopStrategy) throw new Error('Desktop update strategy is already configured.')
  createDesktopStrategy = factory
}
export function createRuntimeUpdateStrategy(
  ...args: Parameters<typeof createUpdateStrategy>
): UpdateStrategy {
  if (createDesktopStrategy) return createDesktopStrategy(...args)
  const unavailable = async (): Promise<never> => {
    throw new DesktopCapabilityUnavailable('Desktop app update')
  }
  return {
    getStatus: () => ({
      state: 'error',
      current: runtimeMetadata().version,
      error: 'Update the Node backend using your package manager.'
    }),
    check: unavailable,
    download: unavailable,
    cancel: unavailable,
    apply: unavailable
  }
}
