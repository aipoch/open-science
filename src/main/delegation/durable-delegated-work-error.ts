const DELEGATION_DISABLED_MESSAGE =
  'Delegation is disabled for this Session. You cannot create new Subagents, but you can still manage existing Subagents and collect their results. Re-enable Delegation for the Session before delegating again.'

class DurableDelegatedWorkError extends Error {
  constructor(
    readonly code:
      | 'admission_rejection'
      | 'authorization'
      | 'conflict'
      | 'capacity'
      | 'unsupported_framework'
      | 'execution_failure'
      | 'durability_failure',
    message: string,
    readonly userFacingUnavailableReason?: string,
    readonly unavailableKind?: 'delegation-disabled'
  ) {
    super(message)
    this.name = 'DurableDelegatedWorkError'
  }

  // Single definition of the Session-policy admission rejection; every enforcement point and
  // test asserts against this factory so the message text exists in exactly one place.
  static delegationDisabled(): DurableDelegatedWorkError {
    return new DurableDelegatedWorkError(
      'admission_rejection',
      DELEGATION_DISABLED_MESSAGE,
      DELEGATION_DISABLED_MESSAGE,
      'delegation-disabled'
    )
  }
}

export { DELEGATION_DISABLED_MESSAGE, DurableDelegatedWorkError }
