import type { TFunction } from 'i18next'

import type { WslSupportHandoff } from '../../../shared/wsl-setup'
import type { ComposerDoc } from '@/pages/workspace/composer/composer-doc'
import { useNavigationStore } from '@/stores/navigation-store'

export const buildWslSupportPrefillDoc = (
  handoff: WslSupportHandoff,
  t: TFunction
): ComposerDoc => ({
  nodes: [
    {
      type: 'text',
      text: [
        t('Set up or repair WSL2 Bash in Open Science.'),
        '',
        t('Review this diagnostic snapshot before sending. It contains no passwords.'),
        t('Diagnostic snapshot:'),
        '```json',
        JSON.stringify(
          {
            schemaVersion: handoff.schemaVersion,
            guide: {
              id: handoff.guide.id,
              version: handoff.guide.version,
              status: handoff.guide.status
            },
            capturedAt: handoff.capturedAt,
            revision: handoff.revision,
            supportReference: handoff.supportReference,
            operationReference: handoff.operationReference,
            errorCode: handoff.errorCode,
            windows: handoff.windows,
            wsl: handoff.wsl,
            distros: handoff.distros,
            selectedTarget: handoff.selectedTarget,
            activatedTarget: handoff.activatedTarget,
            currentBackend: handoff.currentBackend,
            checks: handoff.checks,
            failure: handoff.failure,
            operation: handoff.operation,
            recovery: handoff.recovery
          },
          null,
          2
        ),
        '```',
        '',
        t(
          'Goal: Diagnose the current state, set up or repair WSL2 Bash, save the verified profile, and offer the explicit activation action.'
        ),
        t(
          'Use the bundled WSL2 setup guide and only the setup tools available in this conversation. Recheck after each change. Do not enter or request passwords in chat, replay an uncertain operation, or activate WSL2 Bash without my explicit action.'
        ),
        t(
          'First call {{toolName}} to read the bundled version-matched setup guide and refresh diagnostics.',
          { toolName: 'wsl_setup_diagnostics' }
        )
      ].join('\n')
    }
  ]
})

export const startWslSetupConversation = async (
  projectId: string,
  t: TFunction
): Promise<boolean> => {
  const { handoff, setupSessionToken } = await window.api.settings.createWslSupportHandoff()
  return useNavigationStore
    .getState()
    .startWslSupportConversation(
      projectId,
      buildWslSupportPrefillDoc(handoff, t),
      setupSessionToken
    )
}
