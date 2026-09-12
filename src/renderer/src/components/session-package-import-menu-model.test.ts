import { expect, it, vi } from 'vitest'
import { resolveActionMenuEntries } from './action-menu/action-menu-model'
import {
  PACKAGE_IMPORT_ACTIONS,
  PACKAGE_IMPORT_RECIPE,
  createPackageImportBindings
} from './session-package-import-menu-model'

it.each([true, false])('resolves current-project import (available: %s)', async (available) => {
  const onImport = vi.fn(async () => {})
  const bindings = createPackageImportBindings(available, onImport)
  const entries = resolveActionMenuEntries(
    {
      identityKey: 'project-1',
      catalog: PACKAGE_IMPORT_ACTIONS,
      recipe: PACKAGE_IMPORT_RECIPE,
      bindings
    },
    { projectId: 'project-1' }
  )
  expect(entries).toMatchObject([
    { kind: 'action', action: 'import', disabled: !available, labelKey: 'Import Session package…' }
  ])
  await bindings.import.execute({ projectId: 'project-1' })
  expect(onImport).toHaveBeenCalledWith('project-1')
})
