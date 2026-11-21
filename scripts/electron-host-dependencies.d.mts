import type { Plugin } from 'vite'

export const backendOnlyElectronDependencies: string[]
export function platformBackendOnlyElectronDependencies(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): readonly string[]
export function assertElectronHostDependencies(
  specifiers: Iterable<string>,
  root: string,
  platform?: NodeJS.Platform,
  arch?: NodeJS.Architecture
): void
export function electronHostDependencyGuard(root: string): Plugin
