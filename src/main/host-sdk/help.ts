import {
  HOST_CAPABILITY_OPERATION_KEYS,
  type HostCapabilityOperationKey
} from './capability-projection'

const HOST_SDK_SUBAGENT_OPERATION_IDS = HOST_CAPABILITY_OPERATION_KEYS.map(
  (operation) => `host.${operation}` as const
) as readonly `host.${HostCapabilityOperationKey}`[]
const HOST_SDK_OPERATION_IDS = Object.freeze(
  [
    ...HOST_SDK_SUBAGENT_OPERATION_IDS,
    'host.currentModel',
    'host.llm',
    'host.listModels',
    'host.sessions',
    'host.viewImage'
  ].sort()
)

type HostSdkSubagentOperation = HostCapabilityOperationKey

type HostSdkHelpContext = Readonly<{
  callerRole: 'main' | 'delegate'
  capabilities: Readonly<
    Record<HostSdkSubagentOperation, boolean> & {
      currentModel?: boolean
      llm?: boolean
      listModels?: boolean
      sessions?: boolean
      viewImage?: boolean
    }
  >
}>

type HostSdkAvailability =
  Readonly<{ status: 'available' }> | Readonly<{ status: 'unavailable'; reason: string }>

type HostSdkHelpOperationDescriptor = Readonly<{
  kind: 'operation'
  id: string
  path: string
  aliases: readonly string[]
  summary: string
  callForms: readonly Readonly<{ signature: string; accepts: string }>[]
  request: Readonly<Record<string, unknown>>
  options: Readonly<Record<string, unknown>>
  returns: Readonly<Record<string, unknown>>
  constraints: readonly string[]
  examples: readonly Readonly<{ title: string; code: string }>[]
  resolveAvailability(context: HostSdkHelpContext): HostSdkAvailability
}>

type HostSdkHelpOperation = Omit<
  HostSdkHelpOperationDescriptor,
  'resolveAvailability' | 'path' | 'aliases' | 'summary'
> &
  Readonly<{ availability: HostSdkAvailability }>

type HostSdkHelpCatalog = Readonly<{
  kind: 'catalog'
  coverage: 'registered_topics_only'
  topics: readonly Readonly<{
    id: string
    kind: 'operation'
    path: string
    aliases: readonly string[]
    summary: string
    availability: Readonly<{ status: HostSdkAvailability['status'] }>
  }>[]
  hint: string
}>

type HostSdkHelpNotFound = Readonly<{
  kind: 'not_found'
  query: string
  suggestions: readonly string[]
}>

type HostSdkHelpResult = HostSdkHelpCatalog | HostSdkHelpOperation | HostSdkHelpNotFound

type HostSdkHelpRegistry = Readonly<{
  query(query: unknown, context: HostSdkHelpContext): HostSdkHelpResult
}>

const unavailableProvisioning = (operation: HostSdkSubagentOperation): HostSdkAvailability => ({
  status: 'unavailable',
  reason: `host.${operation} is not provisioned for this Session.`
})

const rootOnlyAvailability =
  (
    operation: HostSdkSubagentOperation,
    delegateReason: string
  ): HostSdkHelpOperationDescriptor['resolveAvailability'] =>
  ({ callerRole, capabilities }) => {
    if (callerRole === 'delegate') return { status: 'unavailable', reason: delegateReason }
    return capabilities[operation] ? { status: 'available' } : unavailableProvisioning(operation)
  }

const NO_OPTIONS = { fields: [] } as const

const DELEGATION_CHILD_FIELDS = [
  { name: 'frameId', type: 'string', required: true, description: 'Child Frame id.' },
  {
    name: 'attemptId',
    type: 'string',
    required: true,
    description: 'Selected Attempt id.'
  },
  { name: 'name', type: 'string', required: true, description: 'Child name.' },
  { name: 'agentName', type: 'string', required: true, description: 'Specialist.' },
  {
    name: 'status',
    type: 'string',
    required: true,
    description: 'running/completed/cancelled/error.'
  },
  {
    name: 'terminalMessageId',
    type: 'string',
    when: 'terminal',
    description: 'Terminal message id.'
  },
  { name: 'response', type: 'string', when: 'completed', description: 'Final text.' },
  {
    name: 'artifactsCreated',
    type: 'array',
    when: 'terminal',
    description: 'Created Artifacts.'
  },
  {
    name: 'cancellationReason',
    type: 'string',
    when: 'cancelled',
    description: 'Stop reason.'
  },
  { name: 'error', type: 'object', when: 'error', description: 'Failure details.' },
  {
    name: 'structuredOutput',
    type: 'JSON value',
    when: 'submitted',
    description: 'Validated output.'
  },
  {
    name: 'structuredOutputUnsatisfied',
    type: 'boolean',
    when: 'terminal without required submission',
    description: 'Required output missing.'
  }
] as const

const DELEGATE_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.delegate',
  path: 'host.delegate',
  aliases: ['delegate'],
  summary: 'Dispatch one child or an atomic fan-out; optionally observe it.',
  callForms: [
    {
      signature: 'await host.delegate(request | requests, options?)',
      accepts: 'object_or_non_empty_array'
    }
  ],
  request: {
    accepts: ['object', 'non_empty_array'],
    fields: [
      {
        name: 'task',
        type: 'string',
        required: true,
        description: 'Self-contained assignment.'
      },
      {
        name: 'name',
        type: 'string',
        required: true,
        description:
          'Unique name: 1–48 code points; no emoji/newlines/control; unique on current branch.'
      },
      {
        name: 'profile',
        type: 'string',
        required: false,
        description: 'Specialist id/name; omit to inherit the parent.'
      },
      {
        name: 'inputs',
        type: 'string[]',
        required: false,
        description: 'Immutable version_id/versionId strings; read-only ./inputs/.'
      },
      {
        name: 'outputSchema',
        type: 'JSON Schema',
        required: false,
        description: 'JSON Schema 2020-12 for host.submitOutput.'
      }
    ]
  },
  options: {
    fields: [
      {
        name: 'wait',
        type: 'boolean',
        required: false,
        default: true,
        description: 'Wait for all children unless false.'
      },
      {
        name: 'timeoutSeconds',
        type: 'number',
        required: false,
        range: '0..1800',
        description: 'Bounded observation; incompatible with wait=false.'
      }
    ]
  },
  returns: {
    discriminator: { name: 'kind', values: ['receipts', 'observations', 'results'] },
    variants: [
      { value: 'receipts', when: 'wait=false', statuses: ['running'] },
      {
        value: 'observations',
        when: 'timeoutSeconds is set',
        statuses: ['running', 'awaiting_user', 'completed', 'cancelled', 'error']
      },
      {
        value: 'results',
        when: 'all-settled wait',
        statuses: ['completed', 'cancelled', 'error']
      }
    ],
    childFields: DELEGATION_CHILD_FIELDS
  },
  constraints: [
    'Main/root only; no nested delegation.',
    'Batches of 1–4 children are admitted atomically.',
    'Use host.agents.list() for profiles; omission inherits.',
    'Timeout observes; it does not stop children.',
    'Async follow-up: host.children() recovers; host.collect(selectors) observes; host.stopChild(frameIds) cancels.'
  ],
  examples: [
    {
      title: 'Async dispatch',
      code: "await host.delegate({name:'Audit',task:'Audit sources.'},{wait:false})"
    }
  ],
  resolveAvailability: ({ callerRole, capabilities }) => {
    if (callerRole === 'delegate') {
      return {
        status: 'unavailable',
        reason: 'Nested delegation is unsupported for Delegate agents.'
      }
    }
    return capabilities.delegate ? { status: 'available' } : unavailableProvisioning('delegate')
  }
}

const INVENTORY_FIELDS = [
  { name: 'frameId', type: 'string', required: true, description: 'Stable child Frame id.' },
  { name: 'attemptId', type: 'string', required: true, description: 'Current Attempt id.' },
  { name: 'title', type: 'string', required: false, description: 'Legacy display title.' },
  { name: 'name', type: 'string', required: true, description: 'Child name.' },
  { name: 'agentName', type: 'string', required: true, description: 'Specialist name.' },
  {
    name: 'status',
    type: 'string',
    required: true,
    description: 'running, awaiting_user, completed, cancelled, or error.'
  }
] as const

const CHILDREN_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.children',
  path: 'host.children',
  aliases: ['children'],
  summary: 'List current direct-child Attempts on the active Message Branch.',
  callForms: [{ signature: 'await host.children(frameIds?)', accepts: 'optional_frame_id_array' }],
  request: {
    fields: [
      {
        name: 'frameIds',
        type: 'string[]',
        required: false,
        description: 'Selected Frames; omit to list all accessible direct children.'
      }
    ]
  },
  options: NO_OPTIONS,
  returns: { type: 'array', itemFields: INVENTORY_FIELDS },
  constraints: [
    'Main/root only; results cover current direct-child Attempts on the active branch.',
    'Results preserve durable admission order; historical Attempt handles are not recovered.'
  ],
  examples: [{ title: 'List children', code: 'const current = await host.children()' }],
  resolveAvailability: rootOnlyAvailability(
    'children',
    'Delegate agents cannot inspect or manage child inventory.'
  )
}

const COLLECT_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.collect',
  path: 'host.collect',
  aliases: ['collect'],
  summary: 'Observe pinned Attempts until any/all settle or time expires.',
  callForms: [
    { signature: 'await host.collect(selectors, options?)', accepts: 'non_empty_selector_array' }
  ],
  request: {
    fields: [
      {
        name: 'selectors',
        type: 'selector[]',
        required: true,
        description: 'Frame ids or {frameId, attemptId} handles; array must be non-empty.'
      }
    ]
  },
  options: {
    fields: [
      {
        name: 'timeoutSeconds',
        type: 'number',
        required: false,
        default: 30,
        range: '0..1800',
        description: 'Observation deadline.'
      },
      {
        name: 'returnWhen',
        type: 'string',
        required: false,
        default: 'all',
        description: 'all waits for every pinned Attempt; any returns after the first settles.'
      }
    ]
  },
  returns: { type: 'array', itemFields: DELEGATION_CHILD_FIELDS },
  constraints: [
    'Main/root only; only direct children on the active branch are collectible.',
    'Expiry returns every latest observation and never stops a child.',
    'To wait for the next settlement with any, first use host.children() and select exact handles for currently running Attempts.'
  ],
  examples: [
    {
      title: 'Collect pinned Attempts',
      code: 'await host.collect(sent.children.map(({ frameId, attemptId }) => ({ frameId, attemptId })))'
    }
  ],
  resolveAvailability: rootOnlyAvailability('collect', 'Delegate agents cannot collect children.')
}

const STOP_CHILD_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.stopChild',
  path: 'host.stopChild',
  aliases: ['stopChild'],
  summary: 'Stop one or more direct-child Frames.',
  callForms: [{ signature: 'await host.stopChild(frameIds)', accepts: 'non_empty_frame_id_array' }],
  request: {
    fields: [
      {
        name: 'frameIds',
        type: 'string[]',
        required: true,
        description: 'Non-empty direct-child Frame ids.'
      }
    ]
  },
  options: NO_OPTIONS,
  returns: {
    type: 'array',
    itemFields: [
      { name: 'frameId', type: 'string', required: true, description: 'Requested Frame.' },
      {
        name: 'status',
        type: 'string',
        required: true,
        description: 'cancelled or already_terminal.'
      }
    ]
  },
  constraints: [
    'Main/root only; each target must be a direct child on the active branch.',
    'Targets settle independently; terminal children are preserved.'
  ],
  examples: [
    {
      title: 'Stop children',
      code: 'await host.stopChild(current.map(({ frameId }) => frameId))'
    }
  ],
  resolveAvailability: rootOnlyAvailability(
    'stopChild',
    'Delegate agents cannot stop or manage child Frames.'
  )
}

const SUBMIT_OUTPUT_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.submitOutput',
  path: 'host.submitOutput',
  aliases: ['submitOutput'],
  summary: 'Submit the authenticated child Attempt structured JSON value.',
  callForms: [{ signature: 'await host.submitOutput(value)', accepts: 'json_value' }],
  request: {
    fields: [
      {
        name: 'value',
        type: 'JSON value',
        required: true,
        description: 'Value validated against this Attempt’s admitted outputSchema.'
      }
    ]
  },
  options: NO_OPTIONS,
  returns: {
    type: 'object',
    fields: [
      { name: 'accepted', type: 'boolean', required: true, description: 'Always true on success.' }
    ]
  },
  constraints: [
    'Available only to a running child delegated with outputSchema.',
    'A configured structured submission is mandatory and supplements rather than replaces the child’s ordinary final response.',
    'The first valid value is durable; equal retry is idempotent and different retry is rejected.'
  ],
  examples: [{ title: 'Submit output', code: 'await host.submitOutput({ answer: 42 })' }],
  resolveAvailability: ({ callerRole, capabilities }) => {
    if (callerRole !== 'delegate') {
      return { status: 'unavailable', reason: 'Only a delegated child Attempt can submit output.' }
    }
    return capabilities.submitOutput
      ? { status: 'available' }
      : unavailableProvisioning('submitOutput')
  }
}

const messageAvailability =
  (
    operation: 'sendFrameMessage' | 'messageReceipt'
  ): HostSdkHelpOperationDescriptor['resolveAvailability'] =>
  ({ capabilities }) =>
    capabilities[operation] ? { status: 'available' } : unavailableProvisioning(operation)

const DELIVERY_RECEIPT_FIELDS = [
  { name: 'requestId', type: 'string', required: true, description: 'Idempotency key.' },
  { name: 'messageId', type: 'string', required: true, description: 'Command id.' },
  { name: 'sourceFrameId', type: 'string', required: true, description: 'Sender Frame.' },
  { name: 'targetFrameId', type: 'string', required: true, description: 'Receiver Frame.' },
  {
    name: 'replyToMessageId',
    type: 'string',
    required: false,
    description: 'Replied-to message.'
  },
  { name: 'queuedAt', type: 'number', required: true, description: 'Queue time.' },
  { name: 'direction', type: 'string', required: true, description: 'Route.' },
  {
    name: 'disposition',
    type: 'string',
    required: true,
    description: 'Delivery form.'
  },
  {
    name: 'targetAttemptId',
    type: 'string',
    when: 'to_child message',
    description: 'Receiver Attempt.'
  },
  {
    name: 'continuationAttemptId',
    type: 'string',
    when: 'to_child continued',
    description: 'New Attempt.'
  },
  {
    name: 'sourceAttemptId',
    type: 'string',
    when: 'to_parent',
    description: 'Sender Attempt.'
  },
  {
    name: 'rootPromptMessageId',
    type: 'string',
    when: 'to_parent',
    description: 'Root prompt id.'
  },
  {
    name: 'status',
    type: 'string',
    required: true,
    description: 'Delivery state.'
  },
  {
    name: 'dispatchStartedAt',
    type: 'number',
    when: 'queued',
    description: 'Dispatch start.'
  },
  { name: 'acceptedAt', type: 'number', when: 'accepted', description: 'Acceptance time.' },
  { name: 'evidence', type: 'string', when: 'accepted', description: 'Acceptance proof.' },
  { name: 'failedAt', type: 'number', when: 'failed', description: 'Failure time.' },
  { name: 'error', type: 'object', when: 'failed', description: 'Failure/retry details.' },
  { name: 'uncertainAt', type: 'number', when: 'uncertain', description: 'Uncertainty time.' },
  {
    name: 'deliveryMayHaveOccurred',
    type: 'boolean',
    when: 'uncertain',
    description: 'Delivery is unknown.'
  },
  {
    name: 'resolution',
    type: 'string',
    when: 'uncertain',
    description: 'Risk resolution.'
  },
  {
    name: 'newRequestRetrySafe',
    type: 'boolean',
    required: true,
    description: 'New-id retry safety.'
  },
  {
    name: 'sameRequestSafe',
    type: 'boolean',
    required: true,
    description: 'Same-id recovery safety.'
  }
] as const

const DELIVERY_DISCRIMINATORS = [
  { name: 'direction', values: ['to_child', 'to_parent'] },
  { name: 'disposition', values: ['message', 'continued'] },
  { name: 'status', values: ['queued', 'accepted', 'failed', 'uncertain'] }
] as const

const SEND_FRAME_MESSAGE_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.sendFrameMessage',
  path: 'host.sendFrameMessage',
  aliases: ['sendFrameMessage'],
  summary: 'Queue a running coordination message to a child or parent.',
  callForms: [
    {
      signature: 'await host.sendFrameMessage(target, message, options?)',
      accepts: 'positional_arguments'
    }
  ],
  request: {
    fields: [
      {
        name: 'target',
        type: 'string',
        required: true,
        description: 'Child Frame id; Delegate uses parent.'
      },
      { name: 'message', type: 'string', required: true, description: 'Non-empty text.' }
    ]
  },
  options: {
    fields: [
      {
        name: 'kind',
        type: 'string',
        required: false,
        default: 'info',
        description: 'info/question.'
      },
      { name: 'requestId', type: 'string', required: false, description: 'Idempotency id.' },
      {
        name: 'replyToMessageId',
        type: 'string',
        required: false,
        description: 'Reply target.'
      }
    ]
  },
  returns: {
    discriminators: DELIVERY_DISCRIMINATORS,
    fields: DELIVERY_RECEIPT_FIELDS
  },
  constraints: [
    'Receipt is delivery evidence, not a reply; same requestId recovers, and uncertain is not auto-retried.',
    'A Subagent uses parent messaging only for coordination while its Attempt is running; its final response is already preserved as the canonical terminal result and should not be duplicated here.'
  ],
  examples: [],
  resolveAvailability: messageAvailability('sendFrameMessage')
}

const MESSAGE_RECEIPT_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.messageReceipt',
  path: 'host.messageReceipt',
  aliases: ['messageReceipt'],
  summary: 'Observe an owned delivery receipt for a bounded time.',
  callForms: [
    { signature: 'await host.messageReceipt(selector, options?)', accepts: 'selector_options' }
  ],
  request: {
    fields: [
      {
        name: 'selector',
        type: 'string',
        required: true,
        description: 'Owned messageId or requestId.'
      }
    ]
  },
  options: {
    fields: [
      {
        name: 'timeoutSeconds',
        type: 'number',
        required: false,
        default: 30,
        range: '0..1800',
        description: 'Observation deadline.'
      }
    ]
  },
  returns: {
    type: 'object',
    discriminators: DELIVERY_DISCRIMINATORS,
    fields: DELIVERY_RECEIPT_FIELDS
  },
  constraints: [
    'Authorization is revalidated on every observation.',
    'Timeout returns the latest receipt and changes no delivery state.'
  ],
  examples: [
    {
      title: 'Observe delivery',
      code: 'await host.messageReceipt(receipt.messageId, { timeoutSeconds: 30 })'
    }
  ],
  resolveAvailability: messageAvailability('messageReceipt')
}

const RESOLVE_MESSAGE_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.resolveMessage',
  path: 'host.resolveMessage',
  aliases: ['resolveMessage'],
  summary: 'Acknowledge uncertain delivery risk and release its lane fence.',
  callForms: [
    {
      signature: "await host.resolveMessage(messageId, { action: 'acknowledge_uncertain' })",
      accepts: 'message_resolution'
    }
  ],
  request: {
    fields: [
      { name: 'messageId', type: 'string', required: true, description: 'Uncertain command id.' }
    ]
  },
  options: {
    fields: [
      {
        name: 'action',
        type: 'string',
        required: true,
        description: 'Must be acknowledge_uncertain.'
      }
    ]
  },
  returns: {
    type: 'object',
    discriminators: [
      { name: 'direction', values: ['to_child', 'to_parent'] },
      { name: 'disposition', values: ['message', 'continued'] },
      { name: 'status', values: ['uncertain'] },
      { name: 'resolution', values: ['acknowledged'] }
    ],
    fields: DELIVERY_RECEIPT_FIELDS
  },
  constraints: ['Main/root only; acknowledgement does not retry or change delivery evidence.'],
  examples: [
    {
      title: 'Release fence',
      code: "await host.resolveMessage(receipt.messageId, { action: 'acknowledge_uncertain' })"
    }
  ],
  resolveAvailability: rootOnlyAvailability(
    'resolveMessage',
    'Only root Main can resolve uncertain delivery.'
  )
}

const VIEW_IMAGE_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.viewImage',
  path: 'host.viewImage',
  aliases: ['viewImage'],
  summary: 'Attach an authorized existing image to the current repl_execute result.',
  callForms: [{ signature: 'await host.viewImage(source, options?)', accepts: 'source_options' }],
  request: {
    fields: [
      {
        name: 'source',
        type: '{ versionId: string } | { path: string }',
        required: true,
        description:
          'Artifact or Upload Version in the current Project, or a path relative to the current execution workspace. For a generated file, pass the same relative path used to save it.'
      }
    ]
  },
  options: {
    fields: [
      {
        name: 'crop',
        type: "{ unit: 'pixels' | 'fraction', left, top, right, bottom }",
        required: false,
        description:
          'Top-left-origin crop in the oriented original image, applied before resize. Pixel coordinates are non-negative integers; fraction coordinates are between 0 and 1. Both forms require left < right and top < bottom and must stay within the image.'
      },
      {
        name: 'maxSize',
        type: 'integer',
        required: false,
        default: 1568,
        range: '1..1568',
        description: 'Maximum output long edge; never upscales.'
      }
    ]
  },
  returns: {
    type: 'object',
    fields: [
      { name: 'attached', type: 'true', required: true, description: 'Staged successfully.' },
      {
        name: 'sourceKind',
        type: 'string',
        required: true,
        description: 'Authorized source kind.'
      },
      { name: 'originalSize', type: 'object', required: true, description: 'Oriented pixels.' },
      { name: 'crop', type: 'object', required: false, description: 'Resolved pixel crop.' },
      { name: 'outputSize', type: 'object', required: true, description: 'Prepared pixels.' },
      { name: 'mimeType', type: 'string', required: true, description: 'image/png or image/jpeg.' }
    ]
  },
  constraints: [
    'Available only during an active repl_execute on a certified visual route.',
    'The returned JavaScript object is attachment metadata, not image bytes. Images reach the Agent only after the enclosing repl_execute succeeds; a failed invocation discards every image it staged.',
    'Attach at most four images per repl_execute invocation. Split larger sets across successful invocations.',
    'Only PNG and JPEG sources are supported.',
    'The output long edge is at most 1568 pixels and is never upscaled. Omit maxSize for the maximum available resolution; use a crop whose long edge is at most 1568 pixels when native pixels are required.'
  ],
  examples: [
    {
      title: 'Inspect a workspace image',
      code: "await host.viewImage({ path: 'results/plot.png' }, { maxSize: 1200 })"
    },
    {
      title: 'Inspect an Artifact crop',
      code: "await host.viewImage({ versionId: compositeVersionId }, { crop: { unit: 'pixels', left: 0, top: 0, right: 800, bottom: 600 } })"
    }
  ],
  resolveAvailability: ({ capabilities }) =>
    capabilities.viewImage
      ? { status: 'available' }
      : { status: 'unavailable', reason: 'host.viewImage requires a certified visual route.' }
}

const CURRENT_MODEL_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.currentModel',
  path: 'host.currentModel',
  aliases: ['currentModel'],
  summary: "Return the calling Session's exact current model id.",
  callForms: [{ signature: 'await host.currentModel()', accepts: 'no_arguments' }],
  request: NO_OPTIONS,
  options: NO_OPTIONS,
  returns: { type: 'string', description: 'Exact model id for the token-bound Session.' },
  constraints: [
    'JavaScript control REPL only; caller-supplied Session identity is never accepted.',
    'Fails when the live Session backend cannot establish an exact model id.'
  ],
  examples: [{ title: 'Inspect the Session model', code: 'await host.currentModel()' }],
  resolveAvailability: ({ capabilities }) =>
    capabilities.currentModel
      ? { status: 'available' }
      : { status: 'unavailable', reason: 'The calling Session model is unavailable.' }
}

const LLM_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.llm',
  path: 'host.llm',
  aliases: ['llm'],
  summary: 'Run bounded, one-shot, tool-less inference through the active Host LLM backend.',
  callForms: [{ signature: 'await host.llm(request, options?)', accepts: 'request_options' }],
  request: {
    accepts: ['prompt_string', 'exact_prompt_object', 'request_array'],
    fields: [
      {
        name: 'prompt',
        type: 'string',
        required: true,
        description: 'Non-empty prompt; an object request accepts no other fields.'
      }
    ]
  },
  options: {
    fields: [
      {
        name: 'maxConcurrency',
        type: 'integer',
        required: false,
        default: 2,
        range: '1..4',
        description: 'Batch-only concurrency bound.'
      }
    ]
  },
  returns: {
    mirrorsInput: true,
    successFields: [
      { name: 'text', type: 'string', required: true, description: 'Generated text.' },
      { name: 'model', type: 'string', required: true, description: 'Observed model id.' },
      {
        name: 'stopReason',
        type: 'string',
        required: true,
        description: 'end_turn, max_tokens, max_turn_requests, refusal, or cancelled.'
      },
      {
        name: 'usage',
        type: 'object',
        required: false,
        description: 'Provider-neutral camelCase token usage when available.'
      }
    ],
    usageFields: [
      {
        name: 'inputTokens',
        type: 'integer',
        required: true,
        description: 'Non-negative input-token count.'
      },
      {
        name: 'cacheTokens',
        type: 'integer',
        required: true,
        description: 'Non-negative aggregate cache-token count.'
      },
      {
        name: 'outputTokens',
        type: 'integer',
        required: true,
        description: 'Non-negative output-token count.'
      },
      {
        name: 'cachedReadTokens',
        type: 'integer',
        required: false,
        description: 'Non-negative cache-read token count when available.'
      },
      {
        name: 'cachedWriteTokens',
        type: 'integer',
        required: false,
        description: 'Non-negative cache-write token count when available.'
      },
      {
        name: 'turnCount',
        type: 'integer',
        required: false,
        description: 'Positive provider-turn count when available.'
      }
    ],
    batchErrorFields: [
      { name: 'error', type: 'string', required: true, description: 'Public per-item failure.' }
    ]
  },
  constraints: [
    'JavaScript control REPL only; no caller-supplied model, tools, files, network, or system prompt.',
    'Options are accepted only for batch calls; batches preserve request order and item count.',
    'Each prompt is limited to 64 KiB; a batch is limited to 32 items and 512 KiB.'
  ],
  examples: [
    { title: 'One-shot inference', code: "await host.llm('Summarize the findings.')" },
    {
      title: 'Bounded fan-out',
      code: "await host.llm(['Classify A.', 'Classify B.'], { maxConcurrency: 2 })"
    }
  ],
  resolveAvailability: ({ capabilities }) =>
    capabilities.llm
      ? { status: 'available' }
      : { status: 'unavailable', reason: 'The active Host LLM route is unavailable.' }
}

const LIST_MODELS_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.listModels',
  path: 'host.listModels',
  aliases: ['listModels'],
  summary: 'List configured models for the current Host LLM Provider and framework.',
  callForms: [{ signature: 'await host.listModels()', accepts: 'no_arguments' }],
  request: NO_OPTIONS,
  options: NO_OPTIONS,
  returns: {
    type: 'string[]',
    description: 'Stable-sorted, deduplicated, frozen model ids.'
  },
  constraints: [
    'Uses the existing configured and validated catalog; never refreshes over the network.',
    'Does not merge model ids across Providers.'
  ],
  examples: [{ title: 'Inspect Host LLM models', code: 'await host.listModels()' }],
  resolveAvailability: ({ capabilities }) =>
    capabilities.listModels
      ? { status: 'available' }
      : { status: 'unavailable', reason: 'The active Host LLM model catalog is unavailable.' }
}

const SESSIONS_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.sessions',
  path: 'host.sessions',
  aliases: ['sessions'],
  summary: 'List or inspect read-only Session diagnostics in the current Project.',
  callForms: [
    { signature: 'await host.sessions.list(options?)', accepts: 'optional_list_options' },
    { signature: 'await host.sessions.inspect(sessionId)', accepts: 'exact_session_id' }
  ],
  request: {
    fields: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        when: 'inspect',
        description: 'Exact Session id in the token-owned current Project.'
      }
    ]
  },
  options: {
    fields: [
      {
        name: 'archived',
        type: "'exclude' | 'include' | 'only'",
        required: false,
        default: 'exclude',
        description: 'List-only archive filter.'
      },
      {
        name: 'search',
        type: 'string',
        required: false,
        description: 'Fuzzy title or exact Session id match.'
      },
      {
        name: 'cursor',
        type: 'string',
        required: false,
        description: 'List-only cursor from the same filters and snapshot.'
      },
      {
        name: 'limit',
        type: 'integer',
        required: false,
        default: 20,
        range: '1..100',
        description: 'Maximum Sessions returned by list.'
      }
    ]
  },
  returns: {
    type: 'SessionDiagnostic | SessionDiagnosticPage',
    listFields: [
      { name: 'totalCount', type: 'integer', required: true, description: 'Total matches.' },
      { name: 'nextCursor', type: 'string', required: false, description: 'Next page.' },
      { name: 'sessions', type: 'SessionDiagnostic[]', required: true, description: 'Page.' }
    ],
    sessionFields: [
      { name: 'sessionId', type: 'string', required: true, description: 'Exact Session id.' },
      { name: 'title', type: 'string', required: true, description: 'Durable title.' },
      { name: 'status', type: 'string', required: true, description: 'Durable Session status.' },
      { name: 'createdAt', type: 'string', required: true, description: 'ISO timestamp.' },
      { name: 'updatedAt', type: 'string', required: true, description: 'ISO timestamp.' },
      { name: 'runtime', type: 'object', required: true, description: 'Bounded live evidence.' },
      {
        name: 'activeConversation',
        type: 'object',
        required: false,
        description: 'Frame, Branch, and message-count navigation metadata.'
      },
      {
        name: 'latestObservation',
        type: 'object',
        required: false,
        description: 'Latest bounded runtime observation.'
      }
    ]
  },
  constraints: [
    'Main JavaScript control REPL only; Project scope comes from the session-bound token.',
    'Read-only and metadata-only; use host.frames for transcript content and Branch traversal.',
    'Live runtime fields are current evidence, not inferred historical state.'
  ],
  examples: [
    { title: 'List recent Sessions', code: 'await host.sessions.list({ limit: 20 })' },
    { title: 'Inspect one Session', code: 'await host.sessions.inspect(sessionId)' }
  ],
  resolveAvailability: ({ callerRole, capabilities }) =>
    callerRole === 'delegate'
      ? { status: 'unavailable', reason: 'host.sessions is available only to Main.' }
      : capabilities.sessions
        ? { status: 'available' }
        : { status: 'unavailable', reason: 'host.sessions is not provisioned for this Session.' }
}

const OPERATION_DESCRIPTORS: readonly HostSdkHelpOperationDescriptor[] = [
  CHILDREN_DESCRIPTOR,
  COLLECT_DESCRIPTOR,
  CURRENT_MODEL_DESCRIPTOR,
  DELEGATE_DESCRIPTOR,
  LLM_DESCRIPTOR,
  LIST_MODELS_DESCRIPTOR,
  MESSAGE_RECEIPT_DESCRIPTOR,
  RESOLVE_MESSAGE_DESCRIPTOR,
  SEND_FRAME_MESSAGE_DESCRIPTOR,
  SESSIONS_DESCRIPTOR,
  STOP_CHILD_DESCRIPTOR,
  SUBMIT_OUTPUT_DESCRIPTOR,
  VIEW_IMAGE_DESCRIPTOR
]

const registeredOperationIds = [...OPERATION_DESCRIPTORS]
  .filter(({ id }) =>
    HOST_SDK_SUBAGENT_OPERATION_IDS.includes(id as (typeof HOST_SDK_SUBAGENT_OPERATION_IDS)[number])
  )
  .map(({ id }) => id)
  .sort() as (typeof HOST_SDK_SUBAGENT_OPERATION_IDS)[number][]
if (JSON.stringify(registeredOperationIds) !== JSON.stringify(HOST_SDK_SUBAGENT_OPERATION_IDS)) {
  throw new Error('Host SDK Subagent Help registry does not match its published operation ids.')
}

const MAX_HELP_QUERY_CHARS = 128
const MAX_CATALOG_RESULT_CHARS = 2_900
const MAX_OPERATION_RESULT_CHARS = 3_600
const MAX_DELEGATE_RESULT_CHARS = 3_200

const normalizeTopic = (value: string): string => value.trim().toLowerCase()

const toBoundedJsonResult = <T extends HostSdkHelpResult>(result: T, maxChars: number): T => {
  const serialized = JSON.stringify(result)
  if (serialized.length > maxChars) {
    throw new Error(
      `Host SDK help result is ${serialized.length} characters; limit is ${maxChars} characters.`
    )
  }
  return JSON.parse(serialized) as T
}

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length]
}

const entries = [...OPERATION_DESCRIPTORS].sort((left, right) => left.id.localeCompare(right.id))
const topics = new Map<string, HostSdkHelpOperationDescriptor>()
for (const descriptor of entries) {
  for (const topic of [descriptor.id, descriptor.path, ...descriptor.aliases]) {
    const normalizedTopic = normalizeTopic(topic)
    const existing = topics.get(normalizedTopic)
    if (existing && existing !== descriptor) {
      throw new Error(`Host SDK help topic "${normalizedTopic}" is registered more than once.`)
    }
    topics.set(normalizedTopic, descriptor)
  }
}

const hostSdkHelp: HostSdkHelpRegistry = Object.freeze({
  query(query, context) {
    if (query === undefined) {
      return toBoundedJsonResult(
        {
          kind: 'catalog',
          coverage: 'registered_topics_only',
          topics: entries.map((descriptor) => {
            const availability = descriptor.resolveAvailability(context)
            return {
              id: descriptor.id,
              kind: descriptor.kind,
              path: descriptor.path,
              aliases: descriptor.aliases,
              summary: descriptor.summary,
              availability: { status: availability.status }
            }
          }),
          hint: 'Query only the operation you plan to call; each topic gives concise field descriptions.'
        },
        MAX_CATALOG_RESULT_CHARS
      )
    }
    if (typeof query !== 'string') throw new Error('host.help query must be a string.')
    if (query.length > MAX_HELP_QUERY_CHARS) {
      throw new Error(`host.help query must be at most ${MAX_HELP_QUERY_CHARS} characters.`)
    }
    const normalizedQuery = normalizeTopic(query)
    const descriptor = topics.get(normalizedQuery)
    if (!descriptor) {
      const suggestions = entries
        .map((candidate) => ({
          id: candidate.id,
          score: Math.min(
            ...[candidate.id, candidate.path, ...candidate.aliases].map((topic) =>
              editDistance(normalizedQuery, normalizeTopic(topic))
            )
          )
        }))
        .sort((left, right) => left.score - right.score || left.id.localeCompare(right.id))
        .slice(0, 3)
        .map(({ id }) => id)
      return toBoundedJsonResult(
        { kind: 'not_found', query, suggestions },
        MAX_CATALOG_RESULT_CHARS
      )
    }
    return toBoundedJsonResult(
      {
        kind: descriptor.kind,
        id: descriptor.id,
        callForms: descriptor.callForms,
        request: descriptor.request,
        options: descriptor.options,
        returns: descriptor.returns,
        constraints: descriptor.constraints,
        examples: descriptor.examples,
        availability: descriptor.resolveAvailability(context)
      },
      descriptor.id === 'host.delegate' ? MAX_DELEGATE_RESULT_CHARS : MAX_OPERATION_RESULT_CHARS
    )
  }
})

export { HOST_SDK_OPERATION_IDS, HOST_SDK_SUBAGENT_OPERATION_IDS, hostSdkHelp }
export type { HostSdkHelpContext, HostSdkHelpRegistry, HostSdkHelpResult }
