import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import type { DelegatedWorkDurableRecords } from './delegated-work-record-types'
import {
  prepareStructuredOutputSchema,
  type PreparedStructuredOutputSchema
} from './structured-output'
import type {
  DurableDelegateRequest,
  DurableSnapshot,
  SpecialistDelegationProfile
} from './durable-delegated-work'

type DurableResolvedAgent = DurableSnapshot['records'][number]['attempts'][number]['resolvedAgent']

const MAX_DELEGATE_NAME_CODE_POINTS = 48

const codePoints = (value: string): string[] => Array.from(value)

const collapseWhitespace = (value: string): string =>
  value.replace(/\p{White_Space}+/gu, ' ').trim()

const normalizeExplicitDelegateName = (value: string): string => {
  const containsControl = codePoints(value).some((point) => {
    const codePoint = point.codePointAt(0)!
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
  })
  if (/[\n\r\u2028\u2029]/u.test(value) || containsControl) {
    throw new DurableDelegatedWorkError(
      'admission_rejection',
      'delegate name contains a newline or control character; remove it and retry'
    )
  }
  if (
    /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u20E3]/u.test(value)
  ) {
    throw new DurableDelegatedWorkError(
      'admission_rejection',
      'delegate name contains an emoji sequence; choose a non-emoji name and retry'
    )
  }
  const normalized = collapseWhitespace(value.normalize('NFC'))
  if (!normalized) {
    throw new DurableDelegatedWorkError(
      'admission_rejection',
      'delegate name is empty after whitespace normalization; provide a 1–48-code-point non-emoji name and retry'
    )
  }
  if (codePoints(normalized).length > MAX_DELEGATE_NAME_CODE_POINTS) {
    throw new DurableDelegatedWorkError(
      'admission_rejection',
      `delegate name exceeds ${MAX_DELEGATE_NAME_CODE_POINTS} Unicode code points; shorten it and retry`
    )
  }
  return normalized
}

const delegateNameKey = (value: string): string =>
  collapseWhitespace(value.normalize('NFC')).toLowerCase()

const allocateDelegateNames = (
  candidates: readonly string[],
  existingNames: readonly string[] = []
): readonly string[] => {
  const occupiedKeys = new Set(existingNames.map(delegateNameKey))
  const allocated = new Array<string>(candidates.length)
  for (const [index, candidate] of candidates.entries()) {
    const name = normalizeExplicitDelegateName(candidate)
    const key = delegateNameKey(name)
    if (occupiedKeys.has(key)) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegate name is already occupied on the current branch; choose a different name and retry'
      )
    }
    occupiedKeys.add(key)
    allocated[index] = name
  }
  return allocated
}

const createAdmissionGate = (): (<Result>(operation: () => Promise<Result>) => Promise<Result>) => {
  let tail: Promise<void> = Promise.resolve()
  return <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = tail.then(operation)
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

const assertNoRemovedDelegateContext = (requests: readonly unknown[]): void => {
  if (
    requests.some(
      (request) =>
        typeof request === 'object' &&
        request !== null &&
        !Array.isArray(request) &&
        Object.prototype.hasOwnProperty.call(request, 'context')
    )
  ) {
    throw new DurableDelegatedWorkError(
      'admission_rejection',
      'delegate context was removed; include all goals, background, constraints, and deliverables in task and retry'
    )
  }
}

class DelegatedWorkAdmissionPolicy {
  constructor(
    private readonly resolveSpecialistById?: (
      profileId: string
    ) => Promise<SpecialistDelegationProfile | undefined> | SpecialistDelegationProfile | undefined,
    private readonly resolveSpecialistReference?: (
      profileReference: string
    ) => Promise<SpecialistDelegationProfile | undefined> | SpecialistDelegationProfile | undefined,
    private readonly validateInput?: (identity: string) => Promise<boolean> | boolean
  ) {}

  async admit(
    requestOrRequests: DurableDelegateRequest | readonly DurableDelegateRequest[],
    parentSpecialistProfileId?: string
  ): Promise<
    Readonly<{
      requests: readonly DurableDelegateRequest[]
      resolvedAgents: readonly DurableResolvedAgent[]
      contracts: readonly (PreparedStructuredOutputSchema | undefined)[]
    }>
  > {
    const rawRequests: readonly unknown[] = Array.isArray(requestOrRequests)
      ? requestOrRequests
      : [requestOrRequests]
    assertNoRemovedDelegateContext(rawRequests)
    if (
      rawRequests.length === 0 ||
      rawRequests.some(
        (request) =>
          typeof request !== 'object' ||
          request === null ||
          Array.isArray(request) ||
          !('task' in request) ||
          typeof request.task !== 'string' ||
          collapseWhitespace(request.task).length === 0
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegation requires a non-empty task'
      )
    }
    const unnormalizedRequests = rawRequests as readonly DurableDelegateRequest[]
    if (
      unnormalizedRequests.some(
        (request) => !('name' in request) || typeof request.name !== 'string'
      )
    )
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegation requires an explicit delegate name; provide a 1–48-code-point non-emoji name and retry'
      )
    const requests = unnormalizedRequests.map((request) => ({
      ...request,
      name: normalizeExplicitDelegateName(request.name)
    }))
    if (
      requests.some(
        (request) =>
          request.inputs !== undefined &&
          (!Array.isArray(request.inputs) ||
            request.inputs.some((input) => typeof input !== 'string' || !input.trim()))
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegation inputs must be immutable Version identities'
      )
    }
    const contracts = requests.map((request) =>
      request.outputSchema === undefined
        ? undefined
        : prepareStructuredOutputSchema(request.outputSchema)
    )
    const inheritedAgent = requests.some((request) => request.profile === undefined)
      ? parentSpecialistProfileId === undefined
        ? ({ kind: 'main' } as const)
        : await this.resolveAgent(parentSpecialistProfileId)
      : undefined
    const resolvedAgents = await Promise.all(
      requests.map((request) =>
        request.profile === undefined
          ? (inheritedAgent as DurableResolvedAgent)
          : this.resolveRequestedAgent(request.profile)
      )
    )
    const inputs = requests.flatMap((request) => request.inputs ?? [])
    if (inputs.length > 0) {
      if (!this.validateInput) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'delegation inputs require an immutable Upload or Artifact Version validator'
        )
      }
      const validInputs = await Promise.all(inputs.map(this.validateInput))
      if (validInputs.some((valid) => !valid)) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'delegation inputs must be immutable Upload or Artifact Version identities'
        )
      }
    }
    return { requests, resolvedAgents, contracts }
  }

  buildChildren(
    requests: readonly DurableDelegateRequest[],
    resolvedAgents: readonly DurableResolvedAgent[],
    contracts: readonly (PreparedStructuredOutputSchema | undefined)[],
    executionModel: NonNullable<
      Parameters<
        DelegatedWorkDurableRecords['admitChildren']
      >[0]['children'][number]['executionModel']
    >,
    createId: (prefix: 'frame' | 'message' | 'runtime' | 'attempt') => string,
    now: () => number
  ): Parameters<DelegatedWorkDurableRecords['admitChildren']>[0]['children'] {
    const titles = allocateDelegateNames(requests.map((request) => request.name))
    return requests.map((request, index) => {
      const task = request.task.trim()
      const frameId = createId('frame')
      const attemptId = createId('attempt')
      const contract = contracts[index]
      return {
        frameId,
        attemptId,
        userMessageId: createId('message'),
        name: titles[index],
        request: { ...request, task },
        resolvedAgent: resolvedAgents[index],
        executionModel,
        startedAt: now(),
        ...(contract
          ? {
              structuredOutputEvidence: {
                attemptId,
                dialect: contract.dialect,
                profile: contract.profile,
                schemaDigest: contract.schemaDigest,
                schema: structuredClone(contract.schema)
              }
            }
          : {})
      }
    })
  }

  async resolveAgent(profileId: string | undefined): Promise<DurableResolvedAgent> {
    return this.resolve(profileId, this.resolveSpecialistById, true)
  }

  private async resolveRequestedAgent(
    profileReference: string | undefined
  ): Promise<DurableResolvedAgent> {
    return this.resolve(
      profileReference,
      this.resolveSpecialistReference ?? this.resolveSpecialistById,
      this.resolveSpecialistReference === undefined
    )
  }

  private async resolve(
    profileId: string | undefined,
    resolver:
      | ((
          profileId: string
        ) =>
          | Promise<SpecialistDelegationProfile | undefined>
          | SpecialistDelegationProfile
          | undefined)
      | undefined,
    requireMatchingId: boolean
  ): Promise<DurableResolvedAgent> {
    if (profileId === undefined) return { kind: 'main' }
    if (typeof profileId !== 'string' || !profileId.trim()) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'an explicit Specialist profile identity cannot be empty'
      )
    }
    let profile: SpecialistDelegationProfile | undefined
    try {
      profile = await resolver?.(profileId)
    } catch (error) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        error instanceof Error ? error.message : String(error),
        'The requested Specialist is unavailable. Choose an enabled Specialist in Settings and try again.'
      )
    }
    if (
      !profile ||
      (requireMatchingId && profile.id !== profileId) ||
      !profile.enabled ||
      profile.setupPending === true ||
      !Number.isSafeInteger(profile.revision) ||
      profile.revision < 0
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        `Specialist ${profileId} is unavailable for delegated execution`,
        'The requested Specialist is unavailable. Choose an enabled Specialist in Settings and try again.'
      )
    }
    const displayName = profile.displayName?.trim() || profile.name.trim()
    if (!displayName) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        `Specialist ${profileId} has no display label`,
        'The requested Specialist is unavailable. Choose an enabled Specialist in Settings and try again.'
      )
    }
    return {
      kind: 'specialist',
      profileId: profile.id,
      revision: profile.revision,
      displayName
    }
  }
}

export {
  MAX_DELEGATE_NAME_CODE_POINTS,
  allocateDelegateNames,
  assertNoRemovedDelegateContext,
  createAdmissionGate,
  DelegatedWorkAdmissionPolicy
}
