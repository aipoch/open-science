import type { TFunction } from 'i18next'

import type { WslSupportHandoff } from '../../../shared/wsl-setup'
import type { ComposerDoc } from '@/pages/workspace/composer/composer-doc'

const availability = (value: boolean | undefined, t: TFunction): string =>
  value === true ? t('Available') : value === false ? t('Unavailable') : t('Not checked')

export const buildWslSupportPrefillDoc = (
  handoff: WslSupportHandoff,
  t: TFunction
): ComposerDoc => ({
  nodes: [
    {
      type: 'text',
      text: [
        t('Help me fix Open Science WSL2 Bash.'),
        '',
        t('Safe diagnostic context:'),
        t('Error code: {{code}}', { code: handoff.errorCode }),
        t('Support reference: {{reference}}', { reference: handoff.supportReference }),
        t('WSL version: {{version}}', { version: handoff.versions.wsl }),
        t('Distribution version: {{version}}', { version: handoff.versions.distribution }),
        t('WSL2: {{status}}', { status: availability(handoff.capabilities.wsl2, t) }),
        t('Linux home directory: {{status}}', {
          status: availability(handoff.capabilities.home, t)
        }),
        t('Bash: {{status}}', { status: availability(handoff.capabilities.bash, t) }),
        t('bubblewrap: {{status}}', { status: availability(handoff.capabilities.bwrap, t) }),
        t('Python 3: {{status}}', { status: availability(handoff.capabilities.python3, t) }),
        t('Linux namespaces: {{status}}', {
          status: availability(handoff.capabilities.namespaces, t)
        }),
        t('Local Windows workspace: {{status}}', {
          status: availability(handoff.capabilities.localWorkspace, t)
        }),
        '',
        t('Goal: Restore sandboxed WSL2 Bash, then guide me back to Settings to check again.'),
        t(
          'Give guidance only. Do not switch the shell backend, run a privileged installer, or replay a failed command. If PowerShell diagnostics are needed, you must ask me to use an explicit action first.'
        )
      ].join('\n')
    }
  ]
})
