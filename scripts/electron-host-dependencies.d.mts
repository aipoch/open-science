import type { Plugin } from 'vite'

export const backendOnlyElectronDependencies: string[]
export function assertElectronHostDependencies(specifiers: Iterable<string>, root: string): void
export function electronHostDependencyGuard(root: string): Plugin
