import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'

import type { ProjectFolderProblem } from '@/lib/project-folder-error'

// Folder diagnostics stay collapsed so paths and platform errors never become the alert summary.
export const ProjectFolderNotice = ({
  problem
}: {
  problem: ProjectFolderProblem
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <ErrorNotice
      role="alert"
      level="warning"
      title={
        problem.kind === 'conflict'
          ? t('Project folder is already in use')
          : problem.kind === 'not-found'
            ? t('Project folder not found')
            : problem.kind === 'records-unavailable'
              ? t('Some research records could not be restored')
              : t('Unable to access project folder')
      }
      errorCode={problem.diagnostics || undefined}
      diagnosticsLabel={t('Details')}
    />
  )
}
