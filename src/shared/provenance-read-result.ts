export type ProvenanceReadFailure = {
  kind: 'load-failed' | 'integrity-failed'
  message: string
}

export type ProvenanceReadResult<Value> = Value | { failure: ProvenanceReadFailure }

export class ProvenanceIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProvenanceIntegrityError'
  }
}

// Return domain failures as plain data so both Electron and Web retain their classification.
export const captureProvenanceRead = async <Value>(
  read: () => Promise<Value>
): Promise<ProvenanceReadResult<Value>> => {
  try {
    return await read()
  } catch (error) {
    return {
      failure: {
        kind: error instanceof ProvenanceIntegrityError ? 'integrity-failed' : 'load-failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

export const unwrapProvenanceRead = <Value>(result: ProvenanceReadResult<Value>): Value => {
  if (result && typeof result === 'object' && 'failure' in result) {
    const failure = result.failure as ProvenanceReadFailure
    if (failure.kind === 'integrity-failed') throw new ProvenanceIntegrityError(failure.message)
    throw new Error(failure.message)
  }
  return result as Value
}

export const provenanceReadFailure = (error: unknown): ProvenanceReadFailure => ({
  kind: error instanceof ProvenanceIntegrityError ? 'integrity-failed' : 'load-failed',
  message: error instanceof Error ? error.message : String(error)
})
