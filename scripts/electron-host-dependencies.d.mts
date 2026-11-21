import type { Plugin } from 'vite'

export const backendOnlyElectronDependencies: string[]
export const macBackendOnlyElectronDependencies: string[]
export function assertElectronHostDependencies(
  specifiers: Iterable<string>,
  root: string,
  platform?: NodeJS.Platform
): void
export function electronHostDependencyGuard(root: string): Plugin
