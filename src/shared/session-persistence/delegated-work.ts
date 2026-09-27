import type {
  SessionDelegatedWorkRuntimeContext,
  DelegatedMessageCommand,
  DelegatedQuestionAnswer,
  DelegatedQuestionRequest
} from '../session-runtime-context'
import { isRecord, hasOnlyFields, asString, asNumber } from './primitives'
import { sanitizeDelegatedWorkRecords } from './delegated-records'
import { sanitizeAgentUserChoiceRequest } from '../elicitation'

export const sanitizeSessionDelegatedWorkRuntimeContext = (
  value: unknown
): SessionDelegatedWorkRuntimeContext | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      'records',
      'recordsQuarantine',
      'messageCommands',
      'messageCommandsQuarantine',
      'questionRequests',
      'questionRequestsQuarantine'
    ]) ||
    (value.messageCommands !== undefined && !Array.isArray(value.messageCommands)) ||
    (value.questionRequests !== undefined && !Array.isArray(value.questionRequests))
  ) {
    return undefined
  }
  const sanitizedRecords = sanitizeDelegatedWorkRecords(value.records)
  const records = sanitizedRecords ?? []
  const recordsQuarantine =
    sanitizedRecords === undefined
      ? value.recordsQuarantine === undefined
        ? structuredClone(value.records)
        : {
            // Both payloads remain opaque. The envelope only prevents a later corrupt generation
            // from replacing an earlier quarantine; neither generation becomes read-model records.
            previous: structuredClone(value.recordsQuarantine),
            current: structuredClone(value.records)
          }
      : value.recordsQuarantine === undefined
        ? undefined
        : structuredClone(value.recordsQuarantine)
  const messageCommands: DelegatedMessageCommand[] = []
  const isolatedQuestionOwner = (): Pick<
    SessionDelegatedWorkRuntimeContext,
    'questionRequests' | 'questionRequestsQuarantine'
  > => {
    const isolated = sanitizeSessionDelegatedWorkRuntimeContext({
      records: value.records,
      ...(value.questionRequests === undefined ? {} : { questionRequests: value.questionRequests }),
      ...(value.questionRequestsQuarantine === undefined
        ? {}
        : { questionRequestsQuarantine: value.questionRequestsQuarantine })
    })
    return {
      ...(isolated?.questionRequests === undefined
        ? {}
        : { questionRequests: isolated.questionRequests }),
      ...(isolated?.questionRequestsQuarantine === undefined
        ? {}
        : { questionRequestsQuarantine: isolated.questionRequestsQuarantine })
    }
  }
  if (value.messageCommandsQuarantine !== undefined) {
    return {
      records,
      ...(recordsQuarantine === undefined ? {} : { recordsQuarantine }),
      messageCommandsQuarantine: structuredClone(value.messageCommandsQuarantine),
      ...isolatedQuestionOwner()
    }
  }
  const quarantine = (): SessionDelegatedWorkRuntimeContext => ({
    records,
    ...(recordsQuarantine === undefined ? {} : { recordsQuarantine }),
    messageCommandsQuarantine: structuredClone(value.messageCommands),
    ...isolatedQuestionOwner()
  })
  const commandIds = new Set<string>()
  const commandKeys = new Set<string>()
  for (const raw of (value.messageCommands ?? []) as unknown[]) {
    if (
      !isRecord(raw) ||
      !hasOnlyFields(raw, [
        'messageId',
        'requestId',
        'sourcePrincipal',
        'canonicalDigest',
        'sourceFrameId',
        'sourceAttemptId',
        'targetFrameId',
        'targetAttemptId',
        'continuationAttemptId',
        'rootPromptMessageId',
        'rootOriginMessageId',
        'callerRootMessageId',
        'rootBranchId',
        'rootBranchRevision',
        'direction',
        'disposition',
        'text',
        'kind',
        'replyToMessageId',
        'retryOfMessageId',
        'laneSequence',
        'queuedAt',
        'receipt'
      ]) ||
      !isRecord(raw.receipt)
    )
      return quarantine()
    const required = [
      'messageId',
      'requestId',
      'sourcePrincipal',
      'canonicalDigest',
      'sourceFrameId',
      'targetFrameId',
      'rootOriginMessageId',
      'callerRootMessageId',
      'rootBranchId',
      'rootBranchRevision',
      'direction',
      'disposition',
      'text',
      'kind'
    ].map((key) => asString(raw[key]))
    if (required.some((part) => !part)) return quarantine()
    const [messageId, requestId, sourcePrincipal] = required as string[]
    const laneSequence = asNumber(raw.laneSequence)
    const queuedAt = asNumber(raw.queuedAt)
    const status = asString(raw.receipt.status)
    const identity = `${sourcePrincipal}\u0000${requestId}`
    const optionalStringFields = [
      'sourceAttemptId',
      'targetAttemptId',
      'continuationAttemptId',
      'rootPromptMessageId',
      'replyToMessageId',
      'retryOfMessageId'
    ]
    const optionalStringsValid = optionalStringFields.every(
      (field) => raw[field] === undefined || Boolean(asString(raw[field]))
    )
    const toParent = raw.direction === 'to_parent' && raw.disposition === 'message'
    const toRunningChild = raw.direction === 'to_child' && raw.disposition === 'message'
    const toContinuedChild = raw.direction === 'to_child' && raw.disposition === 'continued'
    const routeValid =
      (toParent &&
        Boolean(asString(raw.sourceAttemptId)) &&
        Boolean(asString(raw.rootPromptMessageId)) &&
        raw.targetAttemptId === undefined &&
        raw.continuationAttemptId === undefined) ||
      (toRunningChild &&
        Boolean(asString(raw.targetAttemptId)) &&
        raw.sourceAttemptId === undefined &&
        raw.rootPromptMessageId === undefined &&
        raw.continuationAttemptId === undefined) ||
      (toContinuedChild &&
        Boolean(asString(raw.continuationAttemptId)) &&
        raw.sourceAttemptId === undefined &&
        raw.rootPromptMessageId === undefined &&
        raw.targetAttemptId === undefined)
    const receiptValid =
      (status === 'queued' &&
        hasOnlyFields(raw.receipt, ['status', 'dispatchStartedAt', 'dispatchEpoch']) &&
        (raw.receipt.dispatchStartedAt === undefined ||
          (asNumber(raw.receipt.dispatchStartedAt) !== undefined &&
            asNumber(raw.receipt.dispatchStartedAt)! >= queuedAt!)) &&
        (raw.receipt.dispatchEpoch === undefined || Boolean(asString(raw.receipt.dispatchEpoch))) &&
        (raw.receipt.dispatchStartedAt === undefined) ===
          (raw.receipt.dispatchEpoch === undefined)) ||
      (status === 'accepted' &&
        hasOnlyFields(raw.receipt, ['status', 'acceptedAt', 'evidence']) &&
        asNumber(raw.receipt.acceptedAt) !== undefined &&
        asNumber(raw.receipt.acceptedAt)! >= queuedAt! &&
        ['provider_prompt_accepted', 'provider_prompt_completed'].includes(
          String(raw.receipt.evidence)
        )) ||
      (status === 'failed' &&
        hasOnlyFields(raw.receipt, ['status', 'failedAt', 'error']) &&
        asNumber(raw.receipt.failedAt) !== undefined &&
        asNumber(raw.receipt.failedAt)! >= queuedAt! &&
        isRecord(raw.receipt.error) &&
        hasOnlyFields(raw.receipt.error, ['code', 'message', 'retryable']) &&
        Boolean(asString(raw.receipt.error.code)) &&
        Boolean(asString(raw.receipt.error.message)) &&
        typeof raw.receipt.error.retryable === 'boolean') ||
      (status === 'uncertain' &&
        hasOnlyFields(raw.receipt, ['status', 'uncertainAt', 'resolution']) &&
        asNumber(raw.receipt.uncertainAt) !== undefined &&
        asNumber(raw.receipt.uncertainAt)! >= queuedAt! &&
        ['pending', 'acknowledged'].includes(String(raw.receipt.resolution)))
    if (
      commandIds.has(messageId) ||
      commandKeys.has(identity) ||
      laneSequence === undefined ||
      !Number.isSafeInteger(laneSequence) ||
      laneSequence < 1 ||
      queuedAt === undefined ||
      queuedAt < 0 ||
      !/^[a-f0-9]{64}$/.test(String(raw.canonicalDigest)) ||
      !optionalStringsValid ||
      !routeValid ||
      !['info', 'question'].includes(String(raw.kind)) ||
      !receiptValid
    )
      return quarantine()
    commandIds.add(messageId)
    commandKeys.add(identity)
    messageCommands.push(structuredClone(raw) as DelegatedMessageCommand)
  }
  const messageOwner = {
    records,
    ...(recordsQuarantine === undefined ? {} : { recordsQuarantine }),
    ...(value.messageCommands === undefined ? {} : { messageCommands })
  }
  const sanitizeAnswers = (
    raw: unknown,
    questionCount: number
  ): DelegatedQuestionAnswer[] | undefined => {
    if (!Array.isArray(raw) || raw.length > questionCount) return undefined
    const answers = raw.flatMap((answer): DelegatedQuestionAnswer[] => {
      if (!isRecord(answer) || !hasOnlyFields(answer, ['questionIndex', 'value'])) return []
      const questionIndex = asNumber(answer.questionIndex)
      const answerValue = asString(answer.value)
      return questionIndex !== undefined &&
        Number.isSafeInteger(questionIndex) &&
        questionIndex >= 0 &&
        questionIndex < questionCount &&
        answerValue &&
        answerValue.length <= 4_000
        ? [{ questionIndex, value: answerValue }]
        : []
    })
    return answers.length === raw.length &&
      new Set(answers.map((answer) => answer.questionIndex)).size === answers.length
      ? answers
      : undefined
  }
  const sanitizeQuestionRequests = (
    rawRequests: unknown
  ): DelegatedQuestionRequest[] | undefined => {
    if (!Array.isArray(rawRequests)) return undefined
    const questionRequests: DelegatedQuestionRequest[] = []
    const questionIds = new Set<string>()
    for (const raw of rawRequests as unknown[]) {
      if (
        !isRecord(raw) ||
        !hasOnlyFields(raw, [
          'requestId',
          'canonicalDigest',
          'sourceFrameId',
          'sourceAttemptId',
          'sourceRuntimeSegmentId',
          'sourceMessageBranchId',
          'rootOriginMessageId',
          'rootBranchId',
          'sourceName',
          'questions',
          'sequence',
          'askedAt',
          'status',
          'draftAnswers',
          'draftQuestionIndex',
          'answers',
          'respondedAt',
          'continuationAttemptId',
          'failure'
        ])
      ) {
        return undefined
      }
      const required = [
        'requestId',
        'canonicalDigest',
        'sourceFrameId',
        'sourceAttemptId',
        'sourceRuntimeSegmentId',
        'sourceMessageBranchId',
        'rootOriginMessageId',
        'rootBranchId',
        'sourceName'
      ].map((field) => asString(raw[field]))
      if (required.some((part) => !part)) return undefined
      const [requestId] = required as string[]
      const questions = sanitizeAgentUserChoiceRequest({
        sessionId: 'delegated-question',
        questions: raw.questions
      })?.questions
      const sequence = asNumber(raw.sequence)
      const askedAt = asNumber(raw.askedAt)
      const draftQuestionIndex = asNumber(raw.draftQuestionIndex)
      const status = asString(raw.status)
      const draftAnswers = questions && sanitizeAnswers(raw.draftAnswers, questions.length)
      const answers =
        raw.answers === undefined || !questions
          ? undefined
          : sanitizeAnswers(raw.answers, questions.length)
      const respondedAt = raw.respondedAt === undefined ? undefined : asNumber(raw.respondedAt)
      const continuationAttemptId =
        raw.continuationAttemptId === undefined ? undefined : asString(raw.continuationAttemptId)
      let failure: { code: string; message: string } | undefined
      if (raw.failure !== undefined) {
        if (!isRecord(raw.failure) || !hasOnlyFields(raw.failure, ['code', 'message'])) {
          return undefined
        }
        const code = asString(raw.failure.code)
        const message = asString(raw.failure.message)
        if (!code || !message) return undefined
        failure = { code, message }
      }
      if (
        questionIds.has(requestId) ||
        !/^[a-f0-9]{64}$/.test(String(raw.canonicalDigest)) ||
        !questions ||
        (raw.sequence !== undefined &&
          (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1)) ||
        askedAt === undefined ||
        askedAt < 0 ||
        !['pending', 'confirmed', 'cancelled', 'failed'].includes(String(status)) ||
        !draftAnswers ||
        draftQuestionIndex === undefined ||
        !Number.isSafeInteger(draftQuestionIndex) ||
        draftQuestionIndex < 0 ||
        draftQuestionIndex >= questions.length ||
        (raw.answers !== undefined && !answers) ||
        (raw.respondedAt !== undefined && (respondedAt === undefined || respondedAt < askedAt)) ||
        (raw.continuationAttemptId !== undefined && !continuationAttemptId) ||
        (status === 'pending' &&
          (answers !== undefined ||
            respondedAt !== undefined ||
            continuationAttemptId !== undefined ||
            failure !== undefined)) ||
        (status === 'confirmed' &&
          (!answers ||
            answers.length !== questions.length ||
            respondedAt === undefined ||
            !continuationAttemptId ||
            failure !== undefined)) ||
        ((status === 'cancelled' || status === 'failed') &&
          (respondedAt === undefined || !failure || continuationAttemptId !== undefined))
      ) {
        return undefined
      }
      questionIds.add(requestId)
      questionRequests.push(structuredClone(raw) as DelegatedQuestionRequest)
    }
    return questionRequests
  }
  if (value.questionRequestsQuarantine !== undefined) {
    if (value.questionRequests !== undefined) {
      return {
        ...messageOwner,
        questionRequestsQuarantine: {
          active: structuredClone(value.questionRequests),
          quarantine: structuredClone(value.questionRequestsQuarantine)
        }
      }
    }
    const recovered = sanitizeQuestionRequests(value.questionRequestsQuarantine)
    return recovered
      ? { ...messageOwner, questionRequests: recovered }
      : {
          ...messageOwner,
          questionRequestsQuarantine: structuredClone(value.questionRequestsQuarantine)
        }
  }
  if (value.questionRequests === undefined) return messageOwner
  const questionRequests = sanitizeQuestionRequests(value.questionRequests)
  if (!questionRequests) {
    return {
      ...messageOwner,
      questionRequestsQuarantine: structuredClone(value.questionRequests)
    }
  }
  return {
    ...messageOwner,
    questionRequests
  }
}
