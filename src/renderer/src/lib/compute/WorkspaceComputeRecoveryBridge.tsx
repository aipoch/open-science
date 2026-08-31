import { useTranslation } from 'react-i18next'

import { SessionPersistenceAlert } from '@/components/SessionPersistenceAlert'
import { useWorkspaceApplicationMessageAdmission } from '@/pages/workspace/workspace-message-queue-controller'

import { useJobAnalysisEffect } from './useJobAnalysisEffect'

type WorkspaceComputeRecoveryBridgeProps = Readonly<{ enabled: boolean }>

// Route-independent owner for durable Compute completion delivery. It sits inside the shared
// Workspace runtime/message-queue providers, so Home and background Sessions recover without
// changing navigation or mounting an active WorkspacePage.
const WorkspaceComputeRecoveryBridge = ({
  enabled
}: WorkspaceComputeRecoveryBridgeProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const admitMessage = useWorkspaceApplicationMessageAdmission()
  const recovery = useJobAnalysisEffect({
    enabled,
    admitMessage,
    sendMessage: () => Promise.resolve(undefined)
  })

  return recovery.error ? (
    <SessionPersistenceAlert
      title={t('Remote job recovery needs attention')}
      message={t(
        'Open Science could not check saved remote jobs. Retry to restore pending result analysis.'
      )}
      onRetry={recovery.retry}
    />
  ) : null
}

export { WorkspaceComputeRecoveryBridge }
