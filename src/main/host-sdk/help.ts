import {
  HOST_CAPABILITY_OPERATION_KEYS,
  type HostCapabilityKey,
  type HostCapabilityOperationKey
} from './capability-projection'
import { DELEGATION_DISABLED_MESSAGE } from '../delegation/durable-delegated-work-error'

const HOST_SDK_SUBAGENT_OPERATION_IDS = HOST_CAPABILITY_OPERATION_KEYS.map(
  (operation) => `host.${operation}` as const
) as readonly `host.${HostCapabilityOperationKey}`[]
const HOST_SDK_OPERATION_IDS = Object.freeze(
  [
    ...HOST_SDK_SUBAGENT_OPERATION_IDS,
    'host.help',
    'host.capabilities',
    'host.skills',
    'host.mcp',
    'host.compute',
    'host.agents',
    'host.artifacts',
    'host.artifactPath',
    'host.lineage',
    'host.frames',
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
  delegationAllowed?: boolean
  capabilities: Readonly<
    Record<HostSdkSubagentOperation, boolean> & Partial<Record<HostCapabilityKey, boolean>>
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
  backgroundSafety?: 'safe' | 'unsafe'
  backgroundSafetyReason?: string
  resolveAvailability(context: HostSdkHelpContext): HostSdkAvailability
}>

type HostSdkHelpOperation = Omit<
  HostSdkHelpOperationDescriptor,
  'resolveAvailability' | 'path' | 'aliases' | 'summary' | 'backgroundSafety'
> &
  Readonly<{
    availability: HostSdkAvailability
    backgroundSafety: 'safe' | 'unsafe'
  }>

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
  resolveAvailability: ({ callerRole, capabilities, delegationAllowed }) => {
    if (callerRole === 'delegate') {
      return {
        status: 'unavailable',
        reason: 'Nested delegation is unsupported for Delegate agents.'
      }
    }
    if (delegationAllowed === false) {
      return { status: 'unavailable', reason: DELEGATION_DISABLED_MESSAGE }
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
  examples: [
    {
      title: 'Send coordination',
      code: "await host.sendFrameMessage(target, 'The source review is ready.')"
    }
  ],
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
  backgroundSafety: 'unsafe',
  backgroundSafetyReason:
    'Images are delivered only in the live foreground repl_execute response; use host.viewImage in foreground.',
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
    'Use host.viewImage during a foreground repl_execute. Only path sources require a trusted execution workspace.',
    'The returned JavaScript object is attachment metadata, not image bytes. Visual results reach the Agent only after the enclosing repl_execute succeeds. A visual model receives images. A text-only model receives descriptions from the configured Vision model. A failed invocation discards every image it staged.',
    'Attach at most four images per repl_execute invocation. Split larger sets across successful invocations.',
    'Only PNG and JPEG sources are supported.',
    'The output long edge is at most 1568 pixels and is never upscaled. Omit maxSize for the maximum available resolution; use a crop whose long edge is at most 1568 pixels when native pixels are required.'
  ],
  examples: [
    {
      title: 'Inspect an Artifact crop',
      code: "await host.viewImage({ versionId: compositeVersionId }, { crop: { unit: 'pixels', left: 0, top: 0, right: 800, bottom: 600 } })"
    }
  ],
  resolveAvailability: ({ capabilities }) =>
    capabilities.viewImage
      ? { status: 'available' }
      : {
          status: 'unavailable',
          reason:
            'Use a foreground repl_execute on a supported model route. For a text-only main model, configure a Vision model in Settings > Model.'
        }
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
  summary: 'Inspect Sessions or read discussion records.',
  callForms: [
    { signature: 'await host.sessions.list(options?)', accepts: 'optional_list_options' },
    { signature: 'await host.sessions.inspect(sessionId)', accepts: 'exact_session_id' },
    {
      signature: 'await host.sessions.read(options?)',
      accepts: 'optional_record_options'
    }
  ],
  request: {
    fields: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        when: 'inspect',
        description: 'Exact Session id for inspect.'
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
        description: 'list: 1..100 Sessions; read: 1..20000 characters, up to 50 index records.'
      },
      {
        name: 'kind',
        type: 'string',
        required: false,
        description:
          'read: overview, context (nearby messages), message, activity, notebook-run, artifact-version, upload-version, review.'
      },
      {
        name: 'id',
        type: 'string',
        required: false,
        description: 'read: native record ID; selected records infer kind and branch.'
      },
      {
        name: 'part',
        type: "'input' | 'result' | 'record'",
        required: false,
        description: 'read only: defaults to the selected focus part.'
      },
      {
        name: 'offset',
        type: 'integer',
        required: false,
        default: 0,
        description: 'read: character/index offset; prefer the returned next object.'
      },
      {
        name: 'branchId',
        type: 'string',
        required: false,
        description: 'read: optional linked Branch for browsing.'
      }
    ]
  },
  returns: {
    type: 'SessionDiagnostic | SessionDiagnosticPage | SessionRecordPage | SessionRecordText',
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
    'Main only. list/inspect use the current Project and return metadata, not transcripts.',
    'read() returns focus/overview. Copy returned read/overview/nearby options.',
    'Follow response.next. Text: 8000 chars default, 20000 max; index: 50 records. incomplete marks missing/truncated source.',
    'Runtime evidence describes now, not history.'
  ],
  examples: [
    { title: 'List recent Sessions', code: 'await host.sessions.list({ limit: 20 })' },

    {
      title: 'Read a linked Session',
      code: 'const selected = await host.sessions.read(); await host.sessions.read(selected.records[0].read)'
    }
  ],
  resolveAvailability: ({ callerRole, capabilities }) =>
    callerRole === 'delegate'
      ? { status: 'unavailable', reason: 'host.sessions is available only to Main.' }
      : capabilities.sessions
        ? { status: 'available' }
        : { status: 'unavailable', reason: 'host.sessions is not provisioned for this Session.' }
}

type HelpField = readonly [name: string, type: string, description: string]
const toRequest = (fields: readonly HelpField[]): HostSdkHelpOperationDescriptor['request'] => ({
  fields: fields.map(([name, type, description]) => ({ name, type, description }))
})

// Namespace topics keep discovery compact. Method queries use the focused contracts below.
type SdkTopic = Readonly<{
  name: string
  summary: string
  callForms: readonly (readonly [signature: string, accepts: string])[]
  fields?: readonly HelpField[]
  returns: string
  constraints?: readonly string[]
  example: string
  capability?: HostCapabilityKey
  backgroundUnsafeReason?: string
}>
const sdkTopic = ({
  name,
  summary,
  callForms,
  fields = [],
  returns,
  constraints = [],
  example,
  capability,
  backgroundUnsafeReason
}: SdkTopic): HostSdkHelpOperationDescriptor => ({
  kind: 'operation',
  id: `host.${name}`,
  path: `host.${name}`,
  aliases: [name],
  summary,
  ...(backgroundUnsafeReason
    ? { backgroundSafety: 'unsafe', backgroundSafetyReason: backgroundUnsafeReason }
    : {}),
  callForms: callForms.map(([signature, accepts]) => ({ signature, accepts })),
  request: toRequest(fields),
  options: NO_OPTIONS,
  returns: { description: returns },
  constraints,
  examples: [{ title: summary, code: example }],
  resolveAvailability: ({ capabilities }) =>
    !capability || capabilities[capability]
      ? { status: 'available' }
      : { status: 'unavailable', reason: `host.${name} is not provisioned for this Session.` }
})

const CORE_DESCRIPTORS = [
  sdkTopic({
    name: 'help',
    summary: 'Read a host API contract.',
    callForms: [
      ['await host.help(topic?)', 'Omit topic for catalog; exact namespace or method for usage.']
    ],
    fields: [['topic', 'string', 'For example skills.read or host.compute.']],
    returns: 'JSON object: catalog, operation or not_found with suggestions.',
    constraints: [
      'Use known calls directly. Help is optional and on demand. Return the object or JSON.stringify it; String(object) loses its contents.'
    ],
    example: "return await host.help('skills.read')"
  }),
  sdkTopic({
    name: 'capabilities',
    summary: 'Inspect Session availability.',
    callForms: [['await host.capabilities()', 'No arguments.']],
    returns: 'Object of boolean flags keyed by host capability.',
    constraints: [
      'Availability only; signatures are in host.help(topic). Do not preflight documented calls.'
    ],
    example: 'return await host.capabilities()'
  }),
  sdkTopic({
    name: 'skills',
    summary: 'Read and author managed Skills.',
    callForms: [
      ['await host.skills.list()', 'List managed and draft Skills.'],
      ["await host.skills.read(name, path = 'SKILL.md')", 'Positional strings, not an object.'],
      ['await host.skills.validate(name)', 'Validate a package.'],
      [
        'await host.skills.edit(name, path, content, oldString?)',
        'Create/replace draft file, or replace one matching non-empty oldString.'
      ],
      ['await host.skills.publish(name, overwrite = false)', 'Publish the validated draft.'],
      ['await host.skills.delete(name)', 'Delete with application approval.']
    ],
    fields: [
      ['name', 'string', 'Canonical managed or draft Skill name.'],
      ['path', 'string', 'Package-relative file path; read defaults to SKILL.md.'],
      ['content', 'string', 'File content or replacement text.'],
      ['oldString', 'string', 'Optional exact, non-empty text to replace.'],
      ['overwrite', 'boolean', 'Whether to replace an existing Personal Skill; default false.']
    ],
    returns:
      'list: [{ id, name, displayName, description, origin, editable }]; read: { name, path, content, origin, files? }; validate: { valid, name, origin, errors, warnings }; mutations: status and Skill identity.',
    constraints: [
      'This is the authoring API, not the generated Connector Skill loader. For mcp-* documentation, use the current framework Skill loader. The shared load_skill tool selects by skill, never by args; other loaders follow their own advertised schema.',
      'Use an already loaded Connector document directly. If loading fails, report the failure; do not probe internal files or guess Connector methods.'
    ],
    example: "const doc = await host.skills.read('skill-creator'); return doc.content",
    capability: 'skills'
  }),
  sdkTopic({
    name: 'mcp',
    summary: 'Call a documented Connector method.',
    callForms: [
      [
        'await host.mcp(server, method, args?)',
        'Positional server and method strings, then one arguments object.'
      ]
    ],
    fields: [
      ['server', 'string', 'Connector id from its loaded Skill, e.g. pubmed.'],
      ['method', 'string', 'Exact method id from that document, e.g. search_articles.'],
      [
        'args',
        'object',
        'Method-specific Input keys; external field names are preserved. Defaults to {}.'
      ]
    ],
    returns: 'The Connector method result, as documented by its Skill.',
    constraints: [
      'There is no host.mcp.list/read namespace. Load the relevant mcp-* Skill through the framework loader if not already loaded; do not guess method names or fields.',
      'PubMed search uses max_results, date_from and date_to. Unknown parameters are rejected, not ignored.'
    ],
    example:
      "return await host.mcp('pubmed', 'search_articles', { query: 'CRISPR', max_results: 5 })",
    capability: 'mcp'
  }),
  sdkTopic({
    name: 'artifacts',
    summary: 'Find Project Artifacts.',
    callForms: [['await host.artifacts(options?)', 'One optional filter object.']],
    fields: [
      [
        'options',
        'object',
        'Optional versionId, frameId, filename, exact (boolean), search, contentType, after, before, cursor, limit. Use nextCursor for the next page.'
      ]
    ],
    returns:
      '{ count, projectId, truncated, nextCursor?, artifacts: [{ id, filename, latestVersionId, contentType, sizeBytes, checksum, projectId, sessionId, rootFrameId, agentFrameId, isUserUpload, createdAt, latestVersionCreatedAt }] }',
    constraints: [
      'Results are scoped to the current Project. Use latestVersionId with artifactPath or lineage.'
    ],
    example: "return await host.artifacts({ filename: 'results.csv', exact: true })",
    capability: 'artifacts'
  }),
  sdkTopic({
    name: 'artifactPath',
    summary: 'Resolve a local Artifact path.',
    callForms: [['await host.artifactPath(versionId)', 'One Artifact Version id string.']],
    fields: [['versionId', 'string', 'A Version in the current Project, not an Artifact id.']],
    returns: 'Absolute local path string.',
    example: 'const path = await host.artifactPath(versionId)',
    capability: 'artifacts'
  }),
  sdkTopic({
    name: 'lineage',
    summary: 'Inspect Artifact provenance.',
    callForms: [
      ['await host.lineage.get(versionId)', 'One Version id.'],
      [
        'await host.lineage.graph(versionId, options?)',
        'One Version id and optional traversal limits.'
      ]
    ],
    fields: [
      ['versionId', 'string', 'Artifact Version id in the current Project.'],
      [
        'options',
        'object',
        'direction: up (default) or down; maxDepth: default 5, max 20; maxNodes: default 100, max 500.'
      ]
    ],
    returns: 'Version provenance or a bounded graph, with camelCase fields.',
    constraints: [
      'get accepts generated Versions only; Uploads are graph leaves/roots. Read Upload metadata with host.artifacts({ versionId }).'
    ],
    example: 'return await host.lineage.get(versionId)',
    capability: 'lineage'
  }),
  sdkTopic({
    name: 'frames',
    summary: 'Inspect conversation Frames.',
    callForms: [
      ['await host.frames.list(options?)', 'Optional Project-scoped filters.'],
      [
        'await host.frames.get(frameId, options?)',
        'Frame id and optional branch/transcript window.'
      ]
    ],
    fields: [
      ['frameId', 'string', 'Frame id returned by list.'],
      [
        'list options',
        'object',
        'Optional sessionId, rootsOnly, kind, archived, search, after, before, limit, cursor.'
      ],
      ['get options', 'object', 'Optional sessionId, branchId, before, limit.']
    ],
    returns:
      'list: { projectId, frames, totalCount, nextCursor? }; get: { projectId, session, frame, branch, transcript, runtimeSegments }.',
    constraints: [
      'Keep branchId when following a transcript; messages may have multiple branches.'
    ],
    example: 'return await host.frames.list({ rootsOnly: true, limit: 10 })',
    capability: 'frames'
  }),
  sdkTopic({
    name: 'agents',
    summary: 'Read and configure Specialists.',
    callForms: [
      ['await host.agents.list()', 'List profiles.'],
      ['await host.agents.get(name)', 'Read a profile.'],
      ['await host.agents.listSkills(nameOrId?)', 'List scoped Skill choices.'],
      ['await host.agents.listConnectors(nameOrId?)', 'List scoped Connector choices.'],
      ['await host.agents.create(input)', 'Create a profile.'],
      ['await host.agents.update(name, patch)', 'Revision-guarded update.'],
      ['await host.agents.attachSkill(name, skillRef, options)', 'Attach with revision.'],
      ['await host.agents.detachSkill(name, skillRef, options)', 'Detach with revision.'],
      ['await host.agents.attachConnector(name, connectorRef, options)', 'Attach with revision.'],
      ['await host.agents.detachConnector(name, connectorRef, options)', 'Detach with revision.'],
      ['await host.agents.switch(nameOrNull)', 'Switch this Session; null returns to Main.'],
      ['await host.agents.delete(name, options)', 'Delete with revision.']
    ],
    fields: [
      [
        'input',
        'object',
        'name plus optional displayName, description, systemPrompt, iconKey, colorKey, enabled, unrestricted, skillNames, connectorNames.'
      ],
      ['patch', 'object', 'revision plus editable input fields (not name).'],
      ['options', 'object', '{ revision } from the latest profile.'],
      ['skillRef / connectorRef', 'string', 'Use the corresponding catalog reference.']
    ],
    returns:
      'Read operations return catalogs/profiles; ordinary mutations return the actual updated camelCase profile.',
    constraints: [
      'Load customize for the mutation workflow and approval rules. Switch/delete are privileged; do not retry a mutation just to refresh its result.'
    ],
    example: 'return await host.agents.list()',
    capability: 'agents',
    backgroundUnsafeReason:
      'Only agents.switch requires foreground; the other methods support background runs.'
  }),
  sdkTopic({
    name: 'compute',
    summary: 'Run work on a Compute Host.',
    callForms: [
      ['await host.compute.listHosts()', 'Compact enabled-host catalog.'],
      ['await host.compute.list()', 'Full enabled-host records.'],
      ['await host.compute.listRegistered()', 'Registered enabled hosts.'],
      ['await host.compute.listPreferred()', 'Preferred Session hosts.'],
      ['await host.compute.listCompute()', 'Session-enabled compute hosts.'],
      ['host.compute.create(providerId)', 'Synchronous provider handle; no network call.'],
      ['await host.compute.details(providerId, options?)', 'Read/append/replace host knowledge.'],
      ['await handle.callCommand(cmd, intent, options?)', 'Short remote command.'],
      [
        'await handle.submitJob(intent, command, options?)',
        'Submit once; returns a durable job receipt.'
      ],
      ['handle.attachJob(jobId)', 'Synchronous job handle.'],
      ['await job.status()', 'Read status.'],
      ['await job.result()', 'Read collected outputs.'],
      ['await job.cancel()', 'Cancel the job.'],
      ['await handle.setConcurrencyLimit(k)', 'Integer 1..500.'],
      ['await handle.status()', 'Session concurrency status.']
    ],
    fields: [
      ['providerId / jobId', 'string', 'Use catalog/receipt ids.'],
      ['callCommand options', 'object', 'loginShell (default true), timeoutSeconds.'],
      [
        'submitJob options',
        'object',
        'environment, resources, inputs: [{ src, dstFilename?, remotePath? }], outputs, timeoutSeconds, harvest: { exclude?, maxFileMb?, maxTotalMb? }.'
      ],
      [
        'details options',
        'object',
        "mode: 'read' (default), 'append' or 'replace'; text for writes; oldText for exact replace."
      ]
    ],
    returns:
      'Compute records retain their documented wire fields, including provider_id and job_id; submission also returns nextAction.',
    constraints: [
      'Load remote-compute-ssh for provider-specific resources and environments. Follow the submission receipt at the dependency point; do not resubmit to poll.',
      'create/attachJob return handles without await; their methods are async.'
    ],
    example:
      'const handle = host.compute.create(providerId); return await handle.callCommand("pwd", "Inspect working directory")',
    capability: 'compute'
  })
]

// Method details are explicit: slicing a namespace's prose can retain unrelated fields
// or remove a required safety constraint. Signatures and availability come from the owner.
type MethodHelp = Readonly<{
  parameters: readonly HelpField[]
  returns: string
  constraints?: readonly string[]
  example: string
  backgroundUnsafeReason?: string
}>
const SKILL_NAME = ['name', 'string', 'Canonical managed or draft Skill name.'] as const
const AGENT_NAME = ['name', 'string', 'Exact public Specialist name.'] as const
const REVISION = [
  'options',
  'object',
  '{ revision: positive integer } from the reviewed profile.'
] as const
const PROVIDER_ID = ['providerId', 'string', 'Enabled Compute Host id.'] as const
const VERSION_ID = ['versionId', 'string', 'Artifact Version id in the current Project.'] as const
const AUTHORING_SCOPE =
  'Managed/draft Skills only. Use the current framework loader for generated mcp-* documents; do not probe internal files.'
const AGENT_MUTATION =
  'Follow the customize approval workflow; mutations return actual read-back state.'
const COMPUTE_HANDLE =
  'Bind handle = host.compute.create(providerId); this is a handle method, not a host.compute method.'
const JOB_HANDLE =
  'Bind job = host.compute.create(providerId).attachJob(jobId); this is a job handle method.'
const METHOD_HELP: Readonly<Record<string, MethodHelp>> = {
  'skills.list': {
    parameters: [],
    returns: '[{ id, name, displayName, description, origin, editable }]',
    example: 'return await host.skills.list()',
    constraints: [AUTHORING_SCOPE]
  },
  'skills.read': {
    parameters: [
      SKILL_NAME,
      ['path', 'string', 'Optional package-relative path; default SKILL.md.']
    ],
    returns: '{ name, path, content, origin, files? }',
    example: "const doc = await host.skills.read('skill-creator'); return doc.content",
    constraints: [AUTHORING_SCOPE]
  },
  'skills.validate': {
    parameters: [SKILL_NAME],
    returns: '{ valid, name, origin, errors, warnings }',
    example: "return await host.skills.validate('my-skill')",
    constraints: [AUTHORING_SCOPE]
  },
  'skills.edit': {
    parameters: [
      SKILL_NAME,
      ['path', 'string', 'Package-relative file path.'],
      ['content', 'string', 'Whole file content, or replacement text when oldString is supplied.'],
      ['oldString', 'string', 'Optional non-empty exact text, which must match once.']
    ],
    returns: "{ status: 'edited', name, path, origin: 'draft' }",
    example: "return await host.skills.edit('my-skill', 'notes.txt', 'Updated notes')",
    constraints: [
      'Edits a draft; does not publish it. Existing files require oldString; omit it only when creating a new file.'
    ]
  },
  'skills.publish': {
    parameters: [
      SKILL_NAME,
      [
        'overwrite',
        'boolean',
        'Optional; default false. Allow replacing an existing Personal Skill.'
      ]
    ],
    returns: "{ status: 'published', id, name, origin: 'personal' }",
    example: "return await host.skills.publish('my-skill')",
    constraints: [
      'Validates and promotes the draft; removes it after publication. Do not republish to retry a catalog refresh.'
    ]
  },
  'skills.delete': {
    parameters: [SKILL_NAME],
    returns:
      "{ status: 'deleted', operation: 'delete', name } or { status: 'declined', operation: 'delete' }",
    example: "return await host.skills.delete('my-skill')",
    constraints: ['Deletion requires application approval.']
  },
  'lineage.get': {
    parameters: [VERSION_ID],
    returns:
      'Immutable Version provenance: producer, environment and typed input evidence, using camelCase fields.',
    example: 'return await host.lineage.get(versionId)',
    constraints: ['Generated Versions only; Uploads are rejected. Current Project only.']
  },
  'lineage.graph': {
    parameters: [
      VERSION_ID,
      [
        'options',
        'object',
        'Optional direction: up (default) or down; maxDepth: default 5, max 20; maxNodes: default 100, max 500.'
      ]
    ],
    returns:
      'Bounded provenance graph with nodes, edges and truncation/frontier evidence, using camelCase fields.',
    example: "return await host.lineage.graph(versionId, { direction: 'up', maxDepth: 2 })",
    constraints: ['Current Project only. Uploads are permitted.']
  },
  'frames.list': {
    parameters: [
      [
        'options',
        'object',
        'Optional sessionId, rootsOnly (default true), kind, archived (exclude/include/only), search, after, before, cursor, limit (default 20, max 100).'
      ]
    ],
    returns: '{ projectId, frames, totalCount, nextCursor? }',
    example: 'return await host.frames.list({ limit: 10 })',
    constraints: ['Metadata in the current Project; use nextCursor for the next page.']
  },
  'frames.get': {
    parameters: [
      ['frameId', 'string', 'Exact Frame id.'],
      ['options', 'object', 'Optional sessionId, branchId, before, limit (default 40, max 100).']
    ],
    returns: '{ projectId, session, frame, branch, transcript, runtimeSegments }',
    example: 'return await host.frames.get(frameId, { branchId, limit: 20 })',
    constraints: [
      'Defaults to the active Branch. Use transcript.previousCursor as before for older messages; retain branchId.'
    ]
  },
  'sessions.list': {
    parameters: [
      [
        'options',
        'object',
        'Optional archived (exclude/include/only; default exclude), search, cursor, limit (default 20, max 100).'
      ]
    ],
    returns: '{ totalCount, sessions, nextCursor? }',
    example: 'return await host.sessions.list({ limit: 10 })',
    constraints: ['Main only; current Project metadata and live evidence, not transcripts.']
  },
  'sessions.inspect': {
    parameters: [['sessionId', 'string', 'Exact Session id in the current Project.']],
    returns:
      'SessionDiagnostic: sessionId, title, status, createdAt, updatedAt, runtime, activeConversation?, latestObservation?.',
    example: 'return await host.sessions.inspect(sessionId)',
    constraints: ['Main only. Runtime describes now; no transcript or tool payloads.']
  },
  'sessions.read': {
    parameters: [
      [
        'options',
        'object',
        'Optional kind (overview/context/message/activity/notebook-run/artifact-version/upload-version/review), id, part (input/result/record), offset, limit, branchId. Omit for the selected focus.'
      ]
    ],
    returns:
      'SessionRecordPage or SessionRecordText; next gives continuation options, incomplete marks missing/truncated source.',
    example: 'return await host.sessions.read()',
    constraints: [
      'Main only. Copy returned read/overview/nearby/next options. Text defaults to 8000 characters, max 20000; index pages hold up to 50 records.'
    ]
  },
  'agents.list': {
    parameters: [],
    returns: '[{ id, name, displayName, description, enabled }]',
    example: 'return await host.agents.list()',
    constraints: ['Summaries omit revisions and configuration; those belong to agents.get(name).']
  },
  'agents.get': {
    parameters: [AGENT_NAME],
    returns: 'Current Specialist detail including id, name, revision and configuration.',
    example: 'return await host.agents.get(name)'
  },
  'agents.listSkills': {
    parameters: [
      ['nameOrId', 'string', 'Optional exact Skill name or id filter; omit for all visible Skills.']
    ],
    returns: '[{ id, name, displayName, source, mainEnabled, available }]',
    example: 'return await host.agents.listSkills()'
  },
  'agents.listConnectors': {
    parameters: [
      ['nameOrId', 'string', 'Optional exact Connector name or id filter; omit for the catalog.']
    ],
    returns:
      'Public Connector catalog records: identity, description, enabled/authentication/availability state and safe tool information.',
    example: 'return await host.agents.listConnectors()'
  },
  'agents.create': {
    parameters: [
      [
        'input',
        'object',
        'name plus optional displayName, description, systemPrompt, iconKey, colorKey, enabled, unrestricted, skillNames, connectorNames.'
      ]
    ],
    returns: 'Created camelCase Specialist profile including id and revision.',
    example: "return await host.agents.create({ name: 'research-helper' })",
    constraints: [AGENT_MUTATION]
  },
  'agents.update': {
    parameters: [
      AGENT_NAME,
      [
        'patch',
        'object',
        'revision plus changed displayName, description, systemPrompt, iconKey, colorKey, enabled, unrestricted, skillNames or connectorNames.'
      ]
    ],
    returns: 'Updated camelCase Specialist profile including id and revision.',
    example: "return await host.agents.update(name, { revision, description: 'Updated purpose' })",
    constraints: [AGENT_MUTATION, 'Use the reviewed revision; name is immutable.']
  },
  'agents.attachSkill': {
    parameters: [
      AGENT_NAME,
      ['skillRef', 'string', 'Skill catalog id or canonical name.'],
      REVISION
    ],
    returns: 'Updated camelCase Specialist profile.',
    example: 'return await host.agents.attachSkill(name, skillRef, { revision })',
    constraints: [AGENT_MUTATION]
  },
  'agents.detachSkill': {
    parameters: [
      AGENT_NAME,
      ['skillRef', 'string', 'Skill catalog id or canonical name.'],
      REVISION
    ],
    returns: 'Updated camelCase Specialist profile.',
    example: 'return await host.agents.detachSkill(name, skillRef, { revision })',
    constraints: [AGENT_MUTATION]
  },
  'agents.attachConnector': {
    parameters: [AGENT_NAME, ['connectorRef', 'string', 'Connector catalog reference.'], REVISION],
    returns: 'Updated camelCase Specialist profile.',
    example: 'return await host.agents.attachConnector(name, connectorRef, { revision })',
    constraints: [AGENT_MUTATION]
  },
  'agents.detachConnector': {
    parameters: [AGENT_NAME, ['connectorRef', 'string', 'Connector catalog reference.'], REVISION],
    returns: 'Updated camelCase Specialist profile.',
    example: 'return await host.agents.detachConnector(name, connectorRef, { revision })',
    constraints: [AGENT_MUTATION]
  },
  'agents.switch': {
    parameters: [['nameOrNull', 'string | null', 'Target Specialist name; null returns to Main.']],
    returns:
      "{ status: 'approved', operation: 'switch', binding, pendingReconfigure } or { status: 'declined', operation: 'switch' }",
    example: 'return await host.agents.switch(null)',
    constraints: [
      'Foreground only; requires application approval and affects the trusted calling Session. Follow customize for the handoff workflow.'
    ],
    backgroundUnsafeReason: 'Switching requires foreground.'
  },
  'agents.delete': {
    parameters: [AGENT_NAME, REVISION],
    returns: "{ status: 'deleted', name } or a declined result.",
    example: 'return await host.agents.delete(name, { revision })',
    constraints: [
      'Requires application approval. Bound conversations become unavailable rather than falling back to Main.'
    ]
  },
  'compute.listHosts': {
    parameters: [],
    returns: '[{ provider_id, display_name, shape, execution_mode, status, role }]',
    example: 'return await host.compute.listHosts()',
    constraints: [
      'Enabled Session hosts. Status is saved probe evidence, not a live connectivity guarantee.'
    ]
  },
  'compute.list': {
    parameters: [],
    returns: 'Full enabled-host records with their existing wire fields.',
    example: 'return await host.compute.list()'
  },
  'compute.listRegistered': {
    parameters: [],
    returns: 'Registered enabled-host records.',
    example: 'return await host.compute.listRegistered()'
  },
  'compute.listPreferred': {
    parameters: [],
    returns: 'Preferred Session-host records.',
    example: 'return await host.compute.listPreferred()'
  },
  'compute.listCompute': {
    parameters: [],
    returns: 'string[] of enabled provider ids.',
    example: 'return await host.compute.listCompute()'
  },
  'compute.create': {
    parameters: [PROVIDER_ID],
    returns:
      'Provider handle: provider_id and callCommand, submitJob, attachJob, setConcurrencyLimit, status methods.',
    example: 'const handle = host.compute.create(providerId)',
    constraints: ['Synchronous binding; no network call.']
  },
  'compute.details': {
    parameters: [
      PROVIDER_ID,
      [
        'options',
        'object',
        'Optional mode: read (default), append or replace; text for writes; oldText for replace.'
      ]
    ],
    returns: 'Read: { doc, probe }; write: { ok: true }.',
    example: 'return await host.compute.details(providerId)',
    constraints: [
      'SSH hosts only. replace requires an exact oldText match. Writes update saved host knowledge, not the probe snapshot.'
    ]
  },
  'compute.callCommand': {
    parameters: [
      ['cmd', 'string', 'Remote shell command.'],
      ['intent', 'string', 'Purpose of this command.'],
      ['options', 'object', 'Optional loginShell (default true), timeoutSeconds.']
    ],
    returns: '{ exit_code, stdout, stderr, truncated }',
    example:
      'const handle = host.compute.create(providerId); return await handle.callCommand("pwd", "Inspect working directory")',
    constraints: [COMPUTE_HANDLE]
  },
  'compute.submitJob': {
    parameters: [
      ['intent', 'string', 'Purpose of this job.'],
      ['command', 'string', 'Job command.'],
      [
        'options',
        'object',
        'Optional environment, resources, inputs: [{ src, dstFilename?, remotePath? }], outputs, timeoutSeconds, harvest: { exclude?, maxFileMb? (0..100), maxTotalMb? (0..500) }.'
      ]
    ],
    returns: '{ job_id, provider_id, status, remote_workdir, nextAction }',
    example:
      'const handle = host.compute.create(providerId); return await handle.submitJob("Run analysis", "python analysis.py")',
    constraints: [
      COMPUTE_HANDLE,
      'Submit once; retain job_id and follow nextAction at the dependency point. Do not resubmit to poll. Provider-specific resources/environments are in remote-compute-ssh.'
    ]
  },
  'compute.attachJob': {
    parameters: [['jobId', 'string', 'Durable id returned by submission.']],
    returns: 'Job handle: job_id and async status, result, cancel methods.',
    example: 'const handle = host.compute.create(providerId); const job = handle.attachJob(jobId)',
    constraints: [
      COMPUTE_HANDLE,
      'Synchronous binding; later reads verify provider and Session ownership.'
    ]
  },
  'compute.status': {
    parameters: [],
    returns:
      'handle.status(): { session_limit, active_count, queued_count, provider_ceilings }; job.status(): job status record with status and result_final.',
    example: 'const handle = host.compute.create(providerId); return await handle.status()',
    constraints: [
      'handle = host.compute.create(providerId) reports Session concurrency; job = handle.attachJob(jobId) reports that job. These are distinct receivers.'
    ]
  },
  'compute.result': {
    parameters: [],
    returns:
      'JobResult: job_id, status, result_final, exit_code, output_files, featured_files, hidden_files, local_output_root?, left_on_remote, remote_workdir, stdout_tail, stderr_tail, harvest_error, error?.',
    example:
      'const job = host.compute.create(providerId).attachJob(jobId); return await job.result()',
    constraints: [
      JOB_HANDLE,
      'Reads collected outputs; never triggers SSH or harvest. Use result_final to distinguish a final result.'
    ]
  },
  'compute.cancel': {
    parameters: [],
    returns:
      'JobStatusResult with job_id, status, result_final and optional cancellation/error details.',
    example:
      'const job = host.compute.create(providerId).attachJob(jobId); return await job.cancel()',
    constraints: [
      JOB_HANDLE,
      'Requests durable cancellation; do not infer job completion from the request alone.'
    ]
  },
  'compute.setConcurrencyLimit': {
    parameters: [['k', 'integer', 'Session limit, 1..500.']],
    returns: 'No value (undefined) after updating the Session limit.',
    example:
      'const handle = host.compute.create(providerId); return await handle.setConcurrencyLimit(2)',
    constraints: [COMPUTE_HANDLE]
  }
}

const OPERATION_DESCRIPTORS: readonly HostSdkHelpOperationDescriptor[] = [
  ...CORE_DESCRIPTORS,
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
const MAX_CATALOG_RESULT_CHARS = 5_000
const MAX_OPERATION_RESULT_CHARS = 3_600
const MAX_DELEGATE_RESULT_CHARS = 3_400

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
  const register = (topic: string, value: HostSdkHelpOperationDescriptor): void => {
    const key = normalizeTopic(topic)
    if (topics.has(key) && topics.get(key) !== value) {
      throw new Error(`Host SDK help topic "${key}" is registered more than once.`)
    }
    topics.set(key, value)
  }
  for (const topic of [descriptor.id, descriptor.path, ...descriptor.aliases])
    register(topic, descriptor)

  const methods = new Map<string, HostSdkHelpOperationDescriptor['callForms'][number][]>()
  for (const form of descriptor.callForms) {
    const match = form.signature.match(/host\.([A-Za-z]+\.[A-Za-z]+)\(/)
    const handleMethod = form.signature.match(/(?:handle|job)\.([A-Za-z]+)\(/)?.[1]
    const name =
      match?.[1] ?? (handleMethod ? `${descriptor.aliases[0]}.${handleMethod}` : undefined)
    if (name) methods.set(name, [...(methods.get(name) ?? []), form])
  }
  for (const [name, callForms] of methods) {
    const detail = METHOD_HELP[name]
    if (!detail) throw new Error(`Missing Host SDK method help: ${name}`)
    const backgroundUnsafeReason = detail.backgroundUnsafeReason
    const focused: HostSdkHelpOperationDescriptor = {
      ...descriptor,
      id: `host.${name}`,
      callForms,
      request: toRequest(detail.parameters),
      options: NO_OPTIONS,
      returns: { description: detail.returns },
      constraints: detail.constraints ?? [],
      examples: [{ title: name, code: detail.example }],
      backgroundSafety: backgroundUnsafeReason ? 'unsafe' : 'safe',
      ...(backgroundUnsafeReason ? { backgroundSafetyReason: backgroundUnsafeReason } : {})
    }
    register(name, focused)
    register(`host.${name}`, focused)
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
        .filter(({ score }) => score <= 3)
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
        backgroundSafety: descriptor.backgroundSafety ?? 'safe',
        ...(descriptor.backgroundSafetyReason
          ? { backgroundSafetyReason: descriptor.backgroundSafetyReason }
          : {}),
        availability: descriptor.resolveAvailability(context)
      },
      descriptor.id === 'host.delegate' ? MAX_DELEGATE_RESULT_CHARS : MAX_OPERATION_RESULT_CHARS
    )
  }
})

export { HOST_SDK_OPERATION_IDS, HOST_SDK_SUBAGENT_OPERATION_IDS, hostSdkHelp }
export type { HostSdkHelpContext, HostSdkHelpRegistry, HostSdkHelpResult }
