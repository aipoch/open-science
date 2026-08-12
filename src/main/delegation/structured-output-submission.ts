import type { AuthenticatedDelegateCaller } from './durable-delegated-work'
import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import type { DelegatedWorkDurableRecords } from './delegated-work-record-types'
import {
  StructuredOutputEvidenceAssociationError,
  associateStructuredOutputEvidence,
  canonicalStructuredOutputEqual,
  prepareStructuredOutputSchema,
  validateStructuredOutputValue
} from './structured-output'

const submitStructuredOutput = async (
  records: DelegatedWorkDurableRecords,
  caller: AuthenticatedDelegateCaller,
  submittedValue: unknown,
  acceptedAt: number
): Promise<Readonly<{ accepted: true }>> => {
  const snapshot = await records.snapshot()
  const child = snapshot.records.find((candidate) => candidate.frameId === caller.frameId)
  const attempt = child && currentAttempt(child)
  if (
    caller.role !== 'delegate' ||
    !sameSession(snapshot.session, caller.session) ||
    !child ||
    child.parentFrameId !== snapshot.rootFrameId ||
    !caller.attemptId ||
    attempt?.id !== caller.attemptId
  ) {
    throw new DurableDelegatedWorkError(
      'authorization',
      'structured output caller is not the authenticated child Attempt'
    )
  }
  if (attempt.status !== 'running') {
    throw new DurableDelegatedWorkError(
      'conflict',
      'structured output Attempt is no longer writable'
    )
  }
  let evidence
  try {
    evidence = associateStructuredOutputEvidence(snapshot.messages, child.frameId, attempt.id)
  } catch (error) {
    if (!(error instanceof StructuredOutputEvidenceAssociationError)) throw error
    throw new DurableDelegatedWorkError(
      'durability_failure',
      'structured output evidence is malformed or cannot be associated'
    )
  }
  if (!evidence) {
    throw new DurableDelegatedWorkError(
      'conflict',
      'structured output was not declared for this Attempt'
    )
  }
  const contract = prepareStructuredOutputSchema(evidence.schema)
  if (
    contract.schemaDigest !== evidence.schemaDigest ||
    contract.profile !== evidence.profile ||
    contract.dialect !== evidence.dialect
  ) {
    throw new DurableDelegatedWorkError(
      'durability_failure',
      'structured output schema evidence is inconsistent'
    )
  }
  const value = validateStructuredOutputValue(contract, submittedValue)
  if (evidence.accepted) {
    if (canonicalStructuredOutputEqual(evidence.accepted.value, value)) return { accepted: true }
    throw new DurableDelegatedWorkError(
      'conflict',
      'a different structured output was already accepted'
    )
  }
  await records.submitOutput(child.frameId, attempt.id, evidence.schemaDigest, value, acceptedAt)
  return { accepted: true }
}

export { submitStructuredOutput }
