import { PackageOpen } from 'lucide-react'
import type { ActionMenuBinding, ActionMenuDefinition, ActionMenuRecipeEntry } from './action-menu'
export { sessionPackageImportAvailable } from '../lib/session-package-capabilities'

export const PACKAGE_IMPORT_ACTIONS = {
  import: { labelKey: 'Import Session package…', icon: PackageOpen }
} satisfies Record<string, ActionMenuDefinition>
export const PACKAGE_IMPORT_RECIPE = [
  { kind: 'action', action: 'import' }
] as const satisfies readonly ActionMenuRecipeEntry<keyof typeof PACKAGE_IMPORT_ACTIONS>[]

export const createPackageImportBindings = (
  canImport: boolean,
  onImport: (projectId: string) => Promise<void>
): Record<keyof typeof PACKAGE_IMPORT_ACTIONS, ActionMenuBinding<{ projectId: string }>> => ({
  import: { disabled: !canImport, execute: ({ projectId }) => onImport(projectId) }
})
