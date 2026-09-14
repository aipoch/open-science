import { importSessionPackage } from '@/lib/session-package-import'
import {
  ActionMenuItems,
  ActionMenuProvider,
  ActionMenuTarget,
  useActionMenuTarget
} from './action-menu'
import { packageOperationActive, usePackageOperationStore } from '@/stores/package-operation-store'
import {
  PACKAGE_IMPORT_ACTIONS,
  createPackageImportBindings,
  PACKAGE_IMPORT_RECIPE,
  sessionPackageImportAvailable
} from './session-package-import-menu-model'

const ImportMenuItems = (): React.JSX.Element => {
  const menu = useActionMenuTarget<'import'>()
  return (
    <ActionMenuItems
      entries={menu.entries}
      onSelect={(action) => void menu.execute(action)}
      compact={false}
    />
  )
}

export const SessionPackageImportMenu = ({
  projectId
}: {
  projectId: string
}): React.JSX.Element => {
  const busy = usePackageOperationStore((state) => packageOperationActive(state.operation))
  return (
    <ActionMenuProvider>
      <ActionMenuTarget
        asChild
        targetId="project-import"
        identityKey={projectId}
        invocation={{ projectId }}
        catalog={PACKAGE_IMPORT_ACTIONS}
        recipe={PACKAGE_IMPORT_RECIPE}
        bindings={createPackageImportBindings(
          !busy && sessionPackageImportAvailable(),
          importSessionPackage
        )}
      >
        <div>
          <ImportMenuItems />
        </div>
      </ActionMenuTarget>
    </ActionMenuProvider>
  )
}
