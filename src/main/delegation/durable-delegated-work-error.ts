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
    readonly userFacingUnavailableReason?: string
  ) {
    super(message)
    this.name = 'DurableDelegatedWorkError'
  }
}

export { DurableDelegatedWorkError }
