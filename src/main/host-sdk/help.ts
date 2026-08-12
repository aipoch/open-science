const HOST_SDK_SUBAGENT_OPERATION_IDS = [
  'host.children',
  'host.collect',
  'host.delegate',
  'host.message_receipt',
  'host.resolve_message',
  'host.send_frame_message',
  'host.stop_child',
  'host.submit_output'
] as const

type HostSdkSubagentOperation =
  (typeof HOST_SDK_SUBAGENT_OPERATION_IDS)[number] extends `host.${infer Operation}`
    ? Operation
    : never

type HostSdkHelpContext = Readonly<{
  callerRole: 'main' | 'delegate'
  capabilities: Readonly<Record<HostSdkSubagentOperation, boolean>>
}>

type HostSdkAvailability =
  Readonly<{ status: 'available' }> | Readonly<{ status: 'unavailable'; reason: string }>

type HostSdkHelpOperationDescriptor = Readonly<{
  kind: 'operation'
  id: string
  path: string
  aliases: readonly string[]
  summary: string
  call_forms: readonly Readonly<{ signature: string; accepts: string }>[]
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
    availability: HostSdkAvailability
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
  { name: 'frame_id', type: 'string', required: true, description: 'Child Frame id.' },
  {
    name: 'attempt_id',
    type: 'string',
    required: true,
    description: 'Selected Attempt id.'
  },
  { name: 'name', type: 'string', required: true, description: 'Child name.' },
  { name: 'agent_name', type: 'string', required: true, description: 'Specialist.' },
  {
    name: 'status',
    type: 'string',
    required: true,
    description: 'running/completed/cancelled/error.'
  },
  {
    name: 'terminal_message_id',
    type: 'string',
    when: 'terminal',
    description: 'Terminal message id.'
  },
  { name: 'response', type: 'string', when: 'completed', description: 'Final text.' },
  {
    name: 'artifacts_created',
    type: 'array',
    when: 'terminal',
    description: 'Created Artifacts.'
  },
  {
    name: 'cancellation_reason',
    type: 'string',
    when: 'cancelled',
    description: 'Stop reason.'
  },
  { name: 'error', type: 'object', when: 'error', description: 'Failure details.' },
  {
    name: 'structured_output',
    type: 'JSON value',
    when: 'submitted',
    description: 'Validated output.'
  },
  {
    name: 'structured_output_unsatisfied',
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
  call_forms: [
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
        description: 'Immutable Version ids staged read-only under ./inputs/.'
      },
      {
        name: 'output_schema',
        type: 'JSON Schema',
        required: false,
        description: 'JSON Schema 2020-12 for host.submit_output.'
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
        name: 'timeout_seconds',
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
        when: 'timeout_seconds is set',
        statuses: ['running', 'awaiting_user', 'completed', 'cancelled', 'error']
      },
      {
        value: 'results',
        when: 'all-settled wait',
        statuses: ['completed', 'cancelled', 'error']
      }
    ],
    child_fields: DELEGATION_CHILD_FIELDS
  },
  constraints: [
    'Main/root only; no nested delegation.',
    'Non-empty batches are admitted atomically.',
    'Use host.agents.list() for profiles; omission inherits.',
    'Timeout observes; it does not stop children.',
    'Async follow-up: host.children() recovers; host.collect(selectors) observes; host.stop_child(frame_ids) cancels.'
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
  { name: 'frame_id', type: 'string', required: true, description: 'Stable child Frame id.' },
  { name: 'attempt_id', type: 'string', required: true, description: 'Current Attempt id.' },
  { name: 'title', type: 'string', required: false, description: 'Legacy display title.' },
  { name: 'name', type: 'string', required: true, description: 'Child name.' },
  { name: 'agent_name', type: 'string', required: true, description: 'Specialist name.' },
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
  call_forms: [
    { signature: 'await host.children(frame_ids?)', accepts: 'optional_frame_id_array' }
  ],
  request: {
    fields: [
      {
        name: 'frame_ids',
        type: 'string[]',
        required: false,
        description: 'Selected Frames; omit to list all accessible direct children.'
      }
    ]
  },
  options: NO_OPTIONS,
  returns: { type: 'array', item_fields: INVENTORY_FIELDS },
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
  summary: 'Observe pinned child Attempts until all settle or a deadline expires.',
  call_forms: [
    { signature: 'await host.collect(selectors, options?)', accepts: 'non_empty_selector_array' }
  ],
  request: {
    fields: [
      {
        name: 'selectors',
        type: 'selector[]',
        required: true,
        description: 'Frame ids or {frame_id, attempt_id} handles; array must be non-empty.'
      }
    ]
  },
  options: {
    fields: [
      {
        name: 'timeout_seconds',
        type: 'number',
        required: false,
        default: 30,
        range: '0..1800',
        description: 'Observation deadline.'
      }
    ]
  },
  returns: { type: 'array', item_fields: DELEGATION_CHILD_FIELDS },
  constraints: [
    'Main/root only; only direct children on the active branch are collectible.',
    'Expiry returns running observations and never stops a child.'
  ],
  examples: [
    {
      title: 'Collect pinned Attempts',
      code: 'await host.collect(sent.children.map(({ frame_id, attempt_id }) => ({ frame_id, attempt_id })))'
    }
  ],
  resolveAvailability: rootOnlyAvailability('collect', 'Delegate agents cannot collect children.')
}

const STOP_CHILD_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.stop_child',
  path: 'host.stop_child',
  aliases: ['stop_child'],
  summary: 'Stop one or more direct-child Frames.',
  call_forms: [
    { signature: 'await host.stop_child(frame_ids)', accepts: 'non_empty_frame_id_array' }
  ],
  request: {
    fields: [
      {
        name: 'frame_ids',
        type: 'string[]',
        required: true,
        description: 'Non-empty direct-child Frame ids.'
      }
    ]
  },
  options: NO_OPTIONS,
  returns: {
    type: 'array',
    item_fields: [
      { name: 'frame_id', type: 'string', required: true, description: 'Requested Frame.' },
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
      code: 'await host.stop_child(current.map(({ frame_id }) => frame_id))'
    }
  ],
  resolveAvailability: rootOnlyAvailability(
    'stop_child',
    'Delegate agents cannot stop or manage child Frames.'
  )
}

const SUBMIT_OUTPUT_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.submit_output',
  path: 'host.submit_output',
  aliases: ['submit_output'],
  summary: 'Submit the authenticated child Attempt structured JSON value.',
  call_forms: [{ signature: 'await host.submit_output(value)', accepts: 'json_value' }],
  request: {
    fields: [
      {
        name: 'value',
        type: 'JSON value',
        required: true,
        description: 'Value validated against this Attempt’s admitted output_schema.'
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
    'Available only to a running child delegated with output_schema.',
    'The first valid value is durable; equal retry is idempotent and different retry is rejected.'
  ],
  examples: [{ title: 'Submit output', code: 'await host.submit_output({ answer: 42 })' }],
  resolveAvailability: ({ callerRole, capabilities }) => {
    if (callerRole !== 'delegate') {
      return { status: 'unavailable', reason: 'Only a delegated child Attempt can submit output.' }
    }
    return capabilities.submit_output
      ? { status: 'available' }
      : unavailableProvisioning('submit_output')
  }
}

const messageAvailability =
  (
    operation: 'send_frame_message' | 'message_receipt'
  ): HostSdkHelpOperationDescriptor['resolveAvailability'] =>
  ({ capabilities }) =>
    capabilities[operation] ? { status: 'available' } : unavailableProvisioning(operation)

const DELIVERY_RECEIPT_FIELDS = [
  { name: 'request_id', type: 'string', required: true, description: 'Idempotency key.' },
  { name: 'message_id', type: 'string', required: true, description: 'Command id.' },
  { name: 'source_frame_id', type: 'string', required: true, description: 'Sender Frame.' },
  { name: 'target_frame_id', type: 'string', required: true, description: 'Receiver Frame.' },
  {
    name: 'reply_to_message_id',
    type: 'string',
    required: false,
    description: 'Replied-to message.'
  },
  { name: 'queued_at', type: 'number', required: true, description: 'Queue time.' },
  { name: 'direction', type: 'string', required: true, description: 'Route.' },
  {
    name: 'disposition',
    type: 'string',
    required: true,
    description: 'Delivery form.'
  },
  {
    name: 'target_attempt_id',
    type: 'string',
    when: 'to_child message',
    description: 'Receiver Attempt.'
  },
  {
    name: 'continuation_attempt_id',
    type: 'string',
    when: 'to_child continued',
    description: 'New Attempt.'
  },
  {
    name: 'source_attempt_id',
    type: 'string',
    when: 'to_parent',
    description: 'Sender Attempt.'
  },
  {
    name: 'root_prompt_message_id',
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
    name: 'dispatch_started_at',
    type: 'number',
    when: 'queued',
    description: 'Dispatch start.'
  },
  { name: 'accepted_at', type: 'number', when: 'accepted', description: 'Acceptance time.' },
  { name: 'evidence', type: 'string', when: 'accepted', description: 'Acceptance proof.' },
  { name: 'failed_at', type: 'number', when: 'failed', description: 'Failure time.' },
  { name: 'error', type: 'object', when: 'failed', description: 'Failure/retry details.' },
  { name: 'uncertain_at', type: 'number', when: 'uncertain', description: 'Uncertainty time.' },
  {
    name: 'delivery_may_have_occurred',
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
    name: 'new_request_retry_safe',
    type: 'boolean',
    required: true,
    description: 'New-id retry safety.'
  },
  {
    name: 'same_request_safe',
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
  id: 'host.send_frame_message',
  path: 'host.send_frame_message',
  aliases: ['send_frame_message'],
  summary: 'Durably queue a reliable message to a direct child or root parent.',
  call_forms: [
    {
      signature: 'await host.send_frame_message(target, message, options?)',
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
      { name: 'request_id', type: 'string', required: false, description: 'Idempotency id.' },
      {
        name: 'reply_to_message_id',
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
    'Receipt is delivery evidence, not a reply; same request_id recovers, and uncertain is not auto-retried.'
  ],
  examples: [],
  resolveAvailability: messageAvailability('send_frame_message')
}

const MESSAGE_RECEIPT_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.message_receipt',
  path: 'host.message_receipt',
  aliases: ['message_receipt'],
  summary: 'Observe an owned delivery receipt for a bounded time.',
  call_forms: [
    { signature: 'await host.message_receipt(selector, options?)', accepts: 'selector_options' }
  ],
  request: {
    fields: [
      {
        name: 'selector',
        type: 'string',
        required: true,
        description: 'Owned message_id or request_id.'
      }
    ]
  },
  options: {
    fields: [
      {
        name: 'timeout_seconds',
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
      code: 'await host.message_receipt(receipt.message_id, { timeout_seconds: 30 })'
    }
  ],
  resolveAvailability: messageAvailability('message_receipt')
}

const RESOLVE_MESSAGE_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.resolve_message',
  path: 'host.resolve_message',
  aliases: ['resolve_message'],
  summary: 'Acknowledge uncertain delivery risk and release its lane fence.',
  call_forms: [
    {
      signature: "await host.resolve_message(message_id, { action: 'acknowledge_uncertain' })",
      accepts: 'message_resolution'
    }
  ],
  request: {
    fields: [
      { name: 'message_id', type: 'string', required: true, description: 'Uncertain command id.' }
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
      code: "await host.resolve_message(receipt.message_id, { action: 'acknowledge_uncertain' })"
    }
  ],
  resolveAvailability: rootOnlyAvailability(
    'resolve_message',
    'Only root Main can resolve uncertain delivery.'
  )
}

const OPERATION_DESCRIPTORS: readonly HostSdkHelpOperationDescriptor[] = [
  CHILDREN_DESCRIPTOR,
  COLLECT_DESCRIPTOR,
  DELEGATE_DESCRIPTOR,
  MESSAGE_RECEIPT_DESCRIPTOR,
  RESOLVE_MESSAGE_DESCRIPTOR,
  SEND_FRAME_MESSAGE_DESCRIPTOR,
  STOP_CHILD_DESCRIPTOR,
  SUBMIT_OUTPUT_DESCRIPTOR
]

const registeredOperationIds = [...OPERATION_DESCRIPTORS]
  .map(({ id }) => id)
  .sort() as (typeof HOST_SDK_SUBAGENT_OPERATION_IDS)[number][]
if (JSON.stringify(registeredOperationIds) !== JSON.stringify(HOST_SDK_SUBAGENT_OPERATION_IDS)) {
  throw new Error('Host SDK Subagent Help registry does not match its published operation ids.')
}

const MAX_HELP_QUERY_CHARS = 128
const MAX_CATALOG_RESULT_CHARS = 2_500
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
          topics: entries.map((descriptor) => ({
            id: descriptor.id,
            kind: descriptor.kind,
            path: descriptor.path,
            aliases: descriptor.aliases,
            summary: descriptor.summary,
            availability: descriptor.resolveAvailability(context)
          })),
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
        call_forms: descriptor.call_forms,
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

export { HOST_SDK_SUBAGENT_OPERATION_IDS, hostSdkHelp }
export type { HostSdkHelpContext, HostSdkHelpRegistry, HostSdkHelpResult }
