import { useLiteratureHost } from '../renderer-host'
import {
  createLiteratureMetadata,
  type LiteratureMetadata,
  type MetadataSnapshot,
  type LiteratureDetailController
} from '@aipoch/literature-library/client'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
export function useLiteratureMetadata(
  controller: LiteratureDetailController,
  onItemChange: (item: LiteratureItemView) => void
): MetadataSnapshot &
  Pick<
    LiteratureMetadata,
    | 'changeMode'
    | 'externallyUpdated'
    | 'reloadSaved'
    | 'loadLatest'
    | 'resetCompletion'
    | 'toggleOverwrite'
    | 'save'
    | 'complete'
  > {
  const { api: hostApi } = useLiteratureHost()

  const { t } = useTranslation()
  const messages = {
    reload: t('The reference was saved, but could not be reloaded.'),
    update: t('Literature could not be updated.'),
    complete: t('Metadata could not be completed.')
  }
  const [callbacks] = useState(() => {
    let latest = { messages, onItemChange }
    return {
      update: (next: typeof latest): void => {
        latest = next
      },
      notify: (item: LiteratureItemView): void => latest.onItemChange(item),
      messages: (): typeof messages => latest.messages
    }
  })
  useLayoutEffect(() => {
    callbacks.update({ messages, onItemChange })
  })
  const owner = useMemo(
    () =>
      createLiteratureMetadata(controller, {
        transact: (command) => hostApi.literature.transact(command),
        completeMetadata: (request) => hostApi.literature.completeMetadata(request),
        onItemChange: callbacks.notify,
        messages: callbacks.messages
      }),
    [controller, callbacks.notify, callbacks.messages, hostApi.literature]
  )
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
  useLayoutEffect(() => owner.start(), [owner])
  return {
    ...state,
    changeMode: owner.changeMode,
    externallyUpdated: owner.externallyUpdated,
    reloadSaved: owner.reloadSaved,
    loadLatest: owner.loadLatest,
    resetCompletion: owner.resetCompletion,
    toggleOverwrite: owner.toggleOverwrite,
    save: owner.save,
    complete: owner.complete
  }
}
