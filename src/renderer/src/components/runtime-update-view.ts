import type { UpdateStatus } from '../../../shared/update'

// Presentation is derived from observed facts, never from an elapsed timer or error text.
export const runtimeUpdateState = (status: UpdateStatus): string => {
  const { recovery: r, reason } = status
  if (status.outcome)
    return { cancelled: 'S15', recovered: 'S28', installed: 'S27' }[status.outcome]
  if (r?.phase === 'cancelling') return 'S24'
  if (r?.phase === 'checking') return 'S29'
  if (r?.phase === 'recovering') return 'S25'
  if (r?.phase === 'handoff' && status.state === 'applying') return 'S23'
  if (status.state === 'applying') {
    if (r?.phase === 'stopping') return 'S21'
    if (r?.phase === 'stopped' || r?.phase === 'install-check') return 'S22'
    return 'S20'
  }
  if (r?.installation === 'incomplete') return 'S14'
  if (r && ['pending', 'unknown'].includes(r.installation)) return 'S13'
  if (r?.runtime === 'stopped-clean' && r.canRetryInstall) return 'S10'
  if (reason === 'runtime-stop-unclean' || r?.runtime === 'stopped-unclean') return 'S11'
  if (reason === 'runtime-stop-timeout') return 'S09'
  if (reason === 'installation-busy' && r && r.runtime !== 'running') return 'S31'
  if (reason === 'user-cancelled' && r?.canRecover) return 'S12'
  if (reason === 'runtime-configuration-unsupported') return 'S08'
  if (reason === 'active-work') return 'S04'
  if (reason === 'runtime-not-controlled') return r?.detail === 'operation-pending' ? 'S34' : 'S06'
  if (reason === 'installation-busy') {
    if (r?.detail === 'unsupported-channel') return 'S32'
    return r?.detail === 'other-runtime' ? 'S07' : 'S33'
  }
  if (r && r.runtime !== 'running') return 'S12'
  if (reason === 'install-failed')
    return r?.phase === 'preparing' && r.runtime === 'running' && r.installation === 'unchanged'
      ? 'S35'
      : 'S13'
  return r?.canRetryInstall ? 'S30' : 'S01'
}

export const recoveryStates = new Set(['S09', 'S11', 'S12', 'S13', 'S14', 'S25', 'S31'])
export const progressStates = new Set(['S20', 'S21', 'S22', 'S23', 'S24'])
