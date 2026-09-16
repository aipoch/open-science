import { InlineNotice } from '@/components/ui/inline-notice'
import { useTranslation } from 'react-i18next'

import { APP } from '../../../shared/app-config'

// Shared advisory shown wherever the data-root folder is chosen or displayed (onboarding's
// Location step, Settings' Storage panel): the folder's contents are managed by the app and must
// not be hand-edited, or projects/history can break. Shared inline guidance uses a semantic amber
// icon and neutral prose (role="note"); it does not create another global error surface.
const DataRootWarning = (): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <InlineNotice>
      <span>
        {t(
          "{{appName}} manages this folder. Don't move, rename, or delete files inside it — doing so can break your projects and history.",
          { appName: APP.name }
        )}
      </span>
    </InlineNotice>
  )
}

export { DataRootWarning }
