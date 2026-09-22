import type { AcpContextRecoveryState } from '../../../../shared/acp'

export const recoveryStateForDisplay = (
  live: AcpContextRecoveryState | undefined,
  persisted: AcpContextRecoveryState | undefined,
  reasons: { interrupted: string; unknownOutcome: string }
): AcpContextRecoveryState | undefined => {
  if (live || !persisted) return live
  if (!['compacting', 'preparing', 'replacing', 'continuing'].includes(persisted.phase)) {
    return persisted
  }
  const mayHaveExecuted = persisted.phase === 'continuing'
  return {
    phase: 'blocked',
    canRetry: !mayHaveExecuted,
    reason: mayHaveExecuted ? reasons.unknownOutcome : reasons.interrupted
  }
}
