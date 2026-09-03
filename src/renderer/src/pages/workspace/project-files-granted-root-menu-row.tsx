import { Check, Folder, Lock, LockOpen, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useGrantedFoldersStore } from '@/stores/granted-folders-store'
import type { GrantedLocalRoot } from '../../../../shared/local-fs'

import { grantedRootAccessBadgeClassName } from './granted-root-access-badge'

const GrantedRootMenuRow = ({
  root,
  isSelected,
  onSelect,
  onCloseMenu,
  onRequestMutation
}: {
  root: GrantedLocalRoot
  isSelected: boolean
  onSelect: (root: GrantedLocalRoot) => void
  onCloseMenu: () => void
  onRequestMutation: (
    kind: 'change' | 'remove',
    mutation: () => Promise<unknown>,
    confirmLabel: string,
    loadingLabel: string
  ) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const setAccess = useGrantedFoldersStore((state) => state.setAccess)
  const remove = useGrantedFoldersStore((state) => state.remove)

  // The whole row is the submenu trigger: hovering it opens the manage submenu (Radix hover
  // intent), while clicking still selects the folder. Clicking a sub-trigger would normally open
  // the submenu instead, so the click is default-prevented and the menu closed manually.
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger asChild>
        <div
          role="menuitemradio"
          aria-checked={isSelected}
          className="gap-2"
          data-testid={`granted-root-${root.id}`}
          onClick={(event) => {
            event.preventDefault()
            onSelect(root)
            onCloseMenu()
          }}
        >
          <Folder
            className="mt-0.5 size-4 shrink-0 self-start text-text-300"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{root.name}</span>
            <span title={root.path} className="block truncate font-mono text-[11px] text-text-300">
              {root.path}
            </span>
          </span>
          {/* Trailing cluster: badge and check sit 2px apart. */}
          <span className="flex shrink-0 items-center gap-0.5">
            <span className={grantedRootAccessBadgeClassName(root.access)}>{root.access}</span>
            {isSelected ? (
              <Check
                className="size-4 shrink-0 text-primary"
                strokeWidth={2}
                aria-hidden="true"
                data-testid={`granted-root-check-${root.id}`}
              />
            ) : null}
          </span>
        </div>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="z-[70] w-[220px]">
        <DropdownMenuLabel
          title={root.path}
          className="truncate font-mono text-[11px] text-text-300"
        >
          {root.path}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {root.access === 'ro' ? (
          <DropdownMenuItem
            className="gap-2"
            data-testid={`granted-root-allow-writes-${root.id}`}
            onSelect={() => {
              onRequestMutation(
                'change',
                () => setAccess(root.id, 'rw'),
                t('Allow writes'),
                t('Changing access mode…')
              )
            }}
          >
            <LockOpen
              className="size-4 shrink-0 text-text-300"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span>{t('Allow writes')}</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            className="gap-2"
            data-testid={`granted-root-make-read-only-${root.id}`}
            onSelect={() => {
              onRequestMutation(
                'change',
                () => setAccess(root.id, 'ro'),
                t('Make read-only'),
                t('Changing access mode…')
              )
            }}
          >
            <Lock className="size-4 shrink-0 text-text-300" strokeWidth={1.8} aria-hidden="true" />
            <span>{t('Make read-only')}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="gap-2 text-danger-000 data-[highlighted]:text-danger-000"
          data-testid={`granted-root-remove-${root.id}`}
          onSelect={() => {
            onRequestMutation('remove', () => remove(root.id), t('Remove access'), t('Removing…'))
          }}
        >
          <Trash2 className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
          <span>{t('Remove access')}</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export { GrantedRootMenuRow }
