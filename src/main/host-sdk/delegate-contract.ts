import type {
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateRequest,
  DurableDelegatedWork
} from '../delegation/durable-delegated-work'
import { MAX_DELEGATE_NAME_CODE_POINTS } from '../delegation/delegated-work-admission'

const RUNNING_OBSERVATION_SCHEMA = {
  type: 'object',
  required: ['frame_id', 'attempt_id', 'name', 'agent_name', 'status'],
  optional: [],
  properties: {
    frame_id: { type: 'string' },
    attempt_id: { type: 'string' },
    name: { type: 'string' },
    agent_name: { type: 'string' },
    status: { type: 'string', enum: ['running'] }
  }
} as const

const AWAITING_USER_OBSERVATION_SCHEMA = {
  type: 'object',
  required: ['frame_id', 'attempt_id', 'name', 'agent_name', 'status'],
  optional: ['title'],
  properties: {
    frame_id: { type: 'string' },
    attempt_id: { type: 'string' },
    title: { type: 'string' },
    name: { type: 'string' },
    agent_name: { type: 'string' },
    status: { type: 'string', enum: ['awaiting_user'] }
  }
} as const

const TERMINAL_RESULT_SCHEMA = {
  type: 'object',
  required: ['frame_id', 'attempt_id', 'name', 'agent_name', 'status', 'artifacts_created'],
  optional: [
    'terminal_message_id',
    'response',
    'cancellation_reason',
    'error',
    'structured_output',
    'structured_output_unsatisfied'
  ],
  properties: {
    frame_id: { type: 'string' },
    attempt_id: { type: 'string' },
    name: { type: 'string', description: 'Child delegation name.' },
    agent_name: { type: 'string', description: 'Resolved Attempt agent display name.' },
    status: { type: 'string', enum: ['completed', 'cancelled', 'error'] },
    terminal_message_id: { type: 'string' },
    response: { type: 'string' },
    artifacts_created: {
      type: 'array',
      items: { type: 'object', description: 'Finalized Artifact Version metadata.' }
    },
    cancellation_reason: {
      type: 'string',
      enum: ['main_agent_stop', 'session_stop', 'runtime_interrupted']
    },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } }
    },
    structured_output: { description: 'Accepted JSON value for the exact Attempt.' },
    structured_output_unsatisfied: { type: 'boolean' }
  }
} as const

const DELEGATE_OBSERVATION_SCHEMA = {
  discriminator: { propertyName: 'status' },
  oneOf: [RUNNING_OBSERVATION_SCHEMA, TERMINAL_RESULT_SCHEMA]
} as const

const DELEGATE_OUTCOME_OBSERVATION_SCHEMA = {
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
          required: ['frame_id', 'attempt_id'],
          properties: { frame_id: { type: 'string' }, attempt_id: { type: 'string' } }
        }
      ]
    }
  },
  options: {
    type: 'object',
    properties: {
      timeout_seconds: { type: 'number', minimum: 0, maximum: 1800, default: 30 }
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
    output_schema: {
      description:
        'Optional JSON Schema Draft 2020-12 contract for child host.submit_output(value).'
    }
  }
} as const

const DELEGATE_OPTIONS_SCHEMA = {
  type: 'object',
  properties: {
    wait: {
      type: 'boolean',
      default: true,
      description: 'Wait for all children to settle when true.'
    },
    timeout_seconds: {
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
              required: ['frame_id', 'attempt_id', 'name', 'agent_name', 'status'],
              optional: [],
              properties: {
                frame_id: { type: 'string' },
                attempt_id: { type: 'string' },
                name: { type: 'string', description: 'Child delegation name.' },
                agent_name: { type: 'string', description: 'Resolved Attempt agent display name.' },
                status: { type: 'string', enum: ['running'] }
              }
            }
          }
        }
      },
      {
        description: 'Returned when options.timeout_seconds is explicit.',
        type: 'object',
        required: ['kind', 'children'],
        optional: [],
        properties: {
          kind: { type: 'string', enum: ['observations'] },
          children: { type: 'array', items: DELEGATE_OUTCOME_OBSERVATION_SCHEMA }
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

const parseDelegateRpcCall = (params: Readonly<Record<string, unknown>>): DelegateRpcCall => {
  const request = params.request
  if (!isRecord(request) && !Array.isArray(request)) {
    throw new Error(
      'host.delegate request must be one object or a non-empty object array; pass it as the first argument.'
    )
  }
  if (params.options !== undefined && !isRecord(params.options)) {
    throw new Error('host.delegate options must be an object; omit it when no options are needed.')
  }
  const requestedOptions = isRecord(params.options) ? params.options : {}
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
    // the existing domain errors for empty arrays, tasks, profiles, and input identities.
    request: Array.isArray(request)
      ? request.map((candidate) => mapRequest(candidate as Record<string, unknown>))
      : mapRequest(request),
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
  const timeoutSeconds = requestedOptions.timeout_seconds
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
  return {
    selectors,
    options: timeoutSeconds === undefined ? {} : { timeoutSeconds }
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
