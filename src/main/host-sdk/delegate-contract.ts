import type {
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateRequest,
  DurableDelegatedWork
} from '../delegation/durable-delegated-work'
import { MAX_DELEGATE_NAME_CODE_POINTS } from '../delegation/delegated-work-admission'

const MAX_DELEGATE_BATCH_ITEMS = 4

const RUNNING_OBSERVATION_SCHEMA = {
  type: 'object',
  required: ['frameId', 'attemptId', 'name', 'agentName', 'status'],
  optional: [],
  properties: {
    frameId: { type: 'string' },
    attemptId: { type: 'string' },
    name: { type: 'string' },
    agentName: { type: 'string' },
    status: { type: 'string', enum: ['running'] }
  }
} as const

const AWAITING_USER_OBSERVATION_SCHEMA = {
  type: 'object',
  required: ['frameId', 'attemptId', 'name', 'agentName', 'status'],
  optional: ['title'],
  properties: {
    frameId: { type: 'string' },
    attemptId: { type: 'string' },
    title: { type: 'string' },
    name: { type: 'string' },
    agentName: { type: 'string' },
    status: { type: 'string', enum: ['awaiting_user'] }
  }
} as const

const TERMINAL_RESULT_SCHEMA = {
  type: 'object',
  required: ['frameId', 'attemptId', 'name', 'agentName', 'status', 'artifactsCreated'],
  optional: [
    'terminalMessageId',
    'response',
    'cancellationReason',
    'error',
    'structuredOutput',
    'structuredOutputUnsatisfied'
  ],
  properties: {
    frameId: { type: 'string' },
    attemptId: { type: 'string' },
    name: { type: 'string', description: 'Child delegation name.' },
    agentName: { type: 'string', description: 'Resolved Attempt agent display name.' },
    status: { type: 'string', enum: ['completed', 'cancelled', 'error'] },
    terminalMessageId: { type: 'string' },
    response: { type: 'string' },
    artifactsCreated: {
      type: 'array',
      items: { type: 'object', description: 'Finalized Artifact Version metadata.' }
    },
    cancellationReason: {
      type: 'string',
      enum: ['main_agent_stop', 'session_stop', 'runtime_interrupted']
    },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } }
    },
    structuredOutput: { description: 'Accepted JSON value for the exact Attempt.' },
    structuredOutputUnsatisfied: { type: 'boolean' }
  }
} as const

const DELEGATE_OBSERVATION_SCHEMA = {
  discriminator: { propertyName: 'status' },
  oneOf: [RUNNING_OBSERVATION_SCHEMA, AWAITING_USER_OBSERVATION_SCHEMA, TERMINAL_RESULT_SCHEMA]
} as const

const COLLECT_AGENT_CONTRACT = {
  selectors: {
    type: 'array',
    minItems: 1,
    items: {
      oneOf: [
        { type: 'string', minLength: 1 },
        {
          type: 'object',
          additionalProperties: false,
          required: ['frameId', 'attemptId'],
          properties: { frameId: { type: 'string' }, attemptId: { type: 'string' } }
        }
      ]
    }
  },
  options: {
    type: 'object',
    additionalProperties: false,
    properties: {
      timeoutSeconds: { type: 'number', minimum: 0, maximum: 1800, default: 30 },
      returnWhen: { type: 'string', enum: ['all', 'any'], default: 'all' }
    }
  },
  returns: { type: 'array', items: DELEGATE_OBSERVATION_SCHEMA },
  errors: {
    thrown_type: 'Error',
    message_prefix: 'host.collect: ',
    domain_error_code_exposed: false
  }
} as const

const DELEGATE_REQUEST_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['task', 'name'],
  properties: {
    task: {
      type: 'string',
      minLength: 1,
      description: 'Non-empty assignment for the Subagent.'
    },
    name: {
      type: 'string',
      minLength: 1,
      maxCodePoints: MAX_DELEGATE_NAME_CODE_POINTS,
      description:
        'Required Subagent display name of 1–48 Unicode code points. Emoji sequences, newlines, and control characters are not allowed. The normalized name must be unique among running and terminal children on the current active root Message Branch; NFC-equivalent, whitespace-collapsed, and lowercase-equivalent names conflict. Names are never derived, truncated, suffixed, or otherwise automatically renamed.'
    },
    profile: {
      type: 'string',
      minLength: 1,
      description:
        'Stable Specialist id or unique exact public name from await host.agents.list(). Omit to inherit the authenticated parent Specialist; a Main Agent parent uses Main Agent.'
    },
    inputs: {
      type: 'array',
      items: {
        type: 'string',
        minLength: 1,
        identity: 'immutable_upload_or_artifact_version'
      },
      description: 'Immutable Upload Version or Artifact Version identities only.'
    },
    outputSchema: {
      description: 'Optional JSON Schema Draft 2020-12 contract for child host.submitOutput(value).'
    }
  }
} as const

const DELEGATE_OPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    wait: {
      type: 'boolean',
      default: true,
      description: 'Wait for all children to settle when true.'
    },
    timeoutSeconds: {
      type: 'number',
      minimum: 0,
      maximum: 1800,
      description: 'Bounded observation wait after every admitted child has established launch.'
    }
  }
} as const

const DELEGATE_AGENT_CONTRACT = {
  request: {
    oneOf: [
      DELEGATE_REQUEST_OBJECT_SCHEMA,
      {
        type: 'array',
        minItems: 1,
        maxItems: MAX_DELEGATE_BATCH_ITEMS,
        items: DELEGATE_REQUEST_OBJECT_SCHEMA
      }
    ]
  },
  options: DELEGATE_OPTIONS_SCHEMA,
  returns: {
    discriminator: { propertyName: 'kind' },
    oneOf: [
      {
        description: 'Returned when options.wait is false.',
        type: 'object',
        required: ['kind', 'children'],
        optional: [],
        properties: {
          kind: { type: 'string', enum: ['receipts'] },
          children: {
            type: 'array',
            items: {
              type: 'object',
              required: ['frameId', 'attemptId', 'name', 'agentName', 'status'],
              optional: [],
              properties: {
                frameId: { type: 'string' },
                attemptId: { type: 'string' },
                name: { type: 'string', description: 'Child delegation name.' },
                agentName: { type: 'string', description: 'Resolved Attempt agent display name.' },
                status: { type: 'string', enum: ['running'] }
              }
            }
          }
        }
      },
      {
        description: 'Returned when options.timeoutSeconds is explicit.',
        type: 'object',
        required: ['kind', 'children'],
        optional: [],
        properties: {
          kind: { type: 'string', enum: ['observations'] },
          children: { type: 'array', items: DELEGATE_OBSERVATION_SCHEMA }
        }
      },
      {
        description: 'Returned when options.wait is omitted or true.',
        type: 'object',
        required: ['kind', 'children'],
        optional: [],
        properties: {
          kind: { type: 'string', enum: ['results'] },
          children: {
            type: 'array',
            items: TERMINAL_RESULT_SCHEMA
          }
        }
      }
    ]
  },
  errors: {
    thrown_type: 'Error',
    message_prefix: 'host.delegate: ',
    domain_error_code_exposed: false,
    conditions: [
      'Invalid requests or unavailable input/Specialist selections reject the call before dispatch.',
      'A missing, empty, newline/control-containing, emoji-containing, over-48-code-point, or current-branch-conflicting name rejects the entire atomic call with corrective retry guidance before dispatch.',
      'Insufficient capacity or an unavailable execution framework rejects the call before dispatch.',
      'Terminal execution failures are returned as result children with status "error" and an error object.'
    ]
  }
} as const

type DelegateRpcCall = Readonly<{
  request: Parameters<DurableDelegatedWork['delegate']>[1]
  options: Readonly<{ wait?: boolean; timeoutSeconds?: number }>
}>

type CollectRpcCall = Readonly<{
  selectors: readonly DurableCollectSelector[]
  options: DurableCollectOptions
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const parseDelegateRpcCall = (params: Readonly<Record<string, unknown>>): DelegateRpcCall => {
  const request = params.request
  const requests = Array.isArray(request) ? request : [request]
  const requestObjects = requests.filter(isRecord)
  if (requests.length === 0 || requestObjects.length !== requests.length) {
    throw new Error(
      'host.delegate request must be one object or a non-empty object array; pass it as the first argument.'
    )
  }
  if (requests.length > MAX_DELEGATE_BATCH_ITEMS) {
    throw new Error(
      `host.delegate request batches must contain from 1 through ${MAX_DELEGATE_BATCH_ITEMS} objects.`
    )
  }
  if (params.options !== undefined && !isRecord(params.options)) {
    throw new Error('host.delegate options must be an object; omit it when no options are needed.')
  }
  const requestedOptions = isRecord(params.options) ? params.options : {}
  if (hasOwn(requestedOptions, 'timeoutSeconds')) {
    throw new Error(
      'host.delegate private RPC options use timeout_seconds; caller-facing timeoutSeconds must be remapped before transport.'
    )
  }
  if (requestedOptions.wait !== undefined && typeof requestedOptions.wait !== 'boolean') {
    throw new Error('host.delegate options.wait must be true or false.')
  }
  const timeoutSeconds = requestedOptions.timeout_seconds
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== 'number' ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds < 0 ||
      timeoutSeconds > 1800)
  ) {
    throw new Error(
      'host.delegate options.timeout_seconds must be a finite number from 0 through 1800; choose a value in that range or omit it.'
    )
  }
  if (requestedOptions.wait === false && timeoutSeconds !== undefined) {
    throw new Error(
      'host.delegate options wait:false and timeout_seconds conflict; omit timeout_seconds or set wait:true.'
    )
  }
  const mapRequest = (candidate: Record<string, unknown>): DurableDelegateRequest => {
    if (hasOwn(candidate, 'outputSchema')) {
      throw new Error(
        'host.delegate private RPC requests use output_schema; caller-facing outputSchema must be remapped before transport.'
      )
    }
    const { output_schema, ...rest } = candidate
    return {
      ...(rest as DurableDelegateRequest),
      ...(output_schema !== undefined
        ? { outputSchema: output_schema as DurableDelegateRequest['outputSchema'] }
        : {})
    }
  }
  return {
    // Semantic request validation remains in DelegatedWorkAdmissionPolicy so RPC callers retain
    // the existing domain errors for tasks, profiles, and input identities.
    request: Array.isArray(request)
      ? requestObjects.map(mapRequest)
      : mapRequest(requestObjects[0]),
    options: {
      ...(typeof requestedOptions.wait === 'boolean' ? { wait: requestedOptions.wait } : {}),
      ...(typeof timeoutSeconds === 'number' ? { timeoutSeconds } : {})
    }
  }
}

const parseCollectRpcCall = (params: Readonly<Record<string, unknown>>): CollectRpcCall => {
  if (!Array.isArray(params.selectors) || params.selectors.length === 0) {
    throw new Error(
      'host.collect selectors must be a non-empty array; pass Frame ids or {frame_id, attempt_id} handles.'
    )
  }
  const selectors = params.selectors.map((selector) => {
    if (typeof selector === 'string' && selector.trim()) return selector
    if (isRecord(selector) && (hasOwn(selector, 'frameId') || hasOwn(selector, 'attemptId'))) {
      throw new Error(
        'host.collect private RPC selectors use {frame_id, attempt_id}; caller-facing selectors must be remapped before transport.'
      )
    }
    if (
      isRecord(selector) &&
      typeof selector.frame_id === 'string' &&
      selector.frame_id.trim() &&
      typeof selector.attempt_id === 'string' &&
      selector.attempt_id.trim()
    ) {
      return { frameId: selector.frame_id, attemptId: selector.attempt_id }
    }
    throw new Error(
      'host.collect selector is invalid; use a non-empty Frame id or {frame_id, attempt_id} strings.'
    )
  })
  if (params.options !== undefined && !isRecord(params.options)) {
    throw new Error('host.collect options must be an object; omit it to use the 30-second default.')
  }
  const requestedOptions = isRecord(params.options) ? params.options : {}
  if (hasOwn(requestedOptions, 'timeoutSeconds')) {
    throw new Error(
      'host.collect private RPC options use timeout_seconds; caller-facing timeoutSeconds must be remapped before transport.'
    )
  }
  if (hasOwn(requestedOptions, 'returnWhen')) {
    throw new Error(
      'host.collect private RPC options use return_when; caller-facing returnWhen must be remapped before transport.'
    )
  }
  const timeoutSeconds = requestedOptions.timeout_seconds
  const returnWhen = requestedOptions.return_when
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== 'number' ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds < 0 ||
      timeoutSeconds > 1800)
  ) {
    throw new Error(
      'host.collect options.timeout_seconds must be a finite number from 0 through 1800; choose a value in that range or omit it.'
    )
  }
  if (returnWhen !== undefined && returnWhen !== 'all' && returnWhen !== 'any') {
    throw new Error('host.collect options.return_when must be all or any; omit it to use all.')
  }
  return {
    selectors,
    options: {
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      ...(returnWhen === undefined ? {} : { returnWhen })
    }
  }
}

export {
  COLLECT_AGENT_CONTRACT,
  DELEGATE_OBSERVATION_SCHEMA,
  DELEGATE_AGENT_CONTRACT,
  parseCollectRpcCall,
  parseDelegateRpcCall
}
export type { CollectRpcCall, DelegateRpcCall }
