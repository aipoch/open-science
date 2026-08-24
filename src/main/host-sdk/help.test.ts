import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { HOST_SDK_OPERATION_IDS, HOST_SDK_SUBAGENT_OPERATION_IDS, hostSdkHelp } from './help'

const provisioned = Object.fromEntries(
  HOST_SDK_SUBAGENT_OPERATION_IDS.map((id) => [id.slice('host.'.length), true])
) as Record<
  (typeof HOST_SDK_SUBAGENT_OPERATION_IDS)[number] extends `host.${infer Op}` ? Op : never,
  boolean
>
const unprovisioned = Object.fromEntries(
  HOST_SDK_SUBAGENT_OPERATION_IDS.map((id) => [id.slice('host.'.length), false])
) as typeof provisioned
const mainContext = { callerRole: 'main', capabilities: provisioned } as const
const delegateContext = { callerRole: 'delegate', capabilities: provisioned } as const

type HelpField = {
  name: string
  type: string
  required?: boolean
  when?: string
  description: string
  default?: unknown
  range?: string
}

type OperationHelp = Extract<ReturnType<typeof hostSdkHelp.query>, { kind: 'operation' }>

const operation = (topic: string, role: 'main' | 'delegate' = 'main'): OperationHelp => {
  const result = hostSdkHelp.query(topic, role === 'main' ? mainContext : delegateContext)
  if (result.kind !== 'operation') throw new Error(`expected operation help for ${topic}`)
  return result
}

const fields = (value: unknown, key = 'fields'): HelpField[] => {
  const record = value as Record<string, unknown>
  const result = record[key]
  if (!Array.isArray(result)) throw new Error(`expected ${key} field descriptions`)
  return result as HelpField[]
}

const named = (items: HelpField[], name: string): HelpField => {
  const result = items.find((field) => field.name === name)
  if (!result) throw new Error(`missing field description for ${name}`)
  return result
}

describe('Host SDK help', () => {
  it('lists only registered operation topics in a compact deterministic catalog', () => {
    const catalog = hostSdkHelp.query(undefined, mainContext)
    expect(catalog).toMatchObject({
      kind: 'catalog',
      coverage: 'registered_topics_only',
      hint: expect.stringMatching(/query only the operation you plan to call/i)
    })
    if (catalog.kind !== 'catalog') throw new Error('expected catalog')
    expect(catalog.topics.map(({ id }) => id)).toEqual([...HOST_SDK_OPERATION_IDS])
    expect(catalog.topics.map(({ id, path, aliases }) => ({ id, path, aliases }))).toEqual(
      HOST_SDK_OPERATION_IDS.map((id) => ({
        id,
        path: id,
        aliases: [id.slice('host.'.length)]
      }))
    )
    expect(JSON.stringify(catalog).length).toBeLessThanOrEqual(2_900)

    const unavailableCatalog = hostSdkHelp.query(undefined, {
      callerRole: 'main',
      capabilities: unprovisioned
    })
    expect(JSON.stringify(unavailableCatalog).length).toBeLessThanOrEqual(2_900)
  })

  it('documents the transient visual-model-gated viewImage contract', () => {
    const help = hostSdkHelp.query('viewImage', {
      ...mainContext,
      capabilities: { ...mainContext.capabilities, viewImage: true }
    })
    expect(help).toMatchObject({
      kind: 'operation',
      id: 'host.viewImage',
      availability: { status: 'available' },
      call_forms: [{ signature: 'await host.viewImage(source, options?)' }]
    })
    if (help.kind !== 'operation') throw new Error('expected operation help')
    const request = JSON.stringify(help.request)
    expect(request).toMatch(/Artifact or Upload Version in the current Project/u)
    expect(request).toMatch(/path relative to the current execution workspace/u)
    expect(request).toMatch(/same relative path used to save it/u)
    expect(request).not.toMatch(/Notebook/u)
  })

  it('documents the zero-argument model introspection contracts independently', () => {
    const capabilities = {
      ...mainContext.capabilities,
      currentModel: true,
      listModels: false
    }
    expect(hostSdkHelp.query('currentModel', { ...mainContext, capabilities })).toMatchObject({
      kind: 'operation',
      id: 'host.currentModel',
      availability: { status: 'available' },
      call_forms: [{ signature: 'await host.currentModel()' }],
      returns: { type: 'string' }
    })
    expect(hostSdkHelp.query('listModels', { ...mainContext, capabilities })).toMatchObject({
      kind: 'operation',
      id: 'host.listModels',
      availability: { status: 'unavailable' },
      call_forms: [{ signature: 'await host.listModels()' }],
      returns: { type: 'string[]' }
    })
  })

  it('documents host.llm through its JavaScript topic', () => {
    const capabilities = { ...mainContext.capabilities, llm: true }
    const help = hostSdkHelp.query('llm', {
      ...mainContext,
      capabilities
    })
    expect(help).toMatchObject({
      kind: 'operation',
      id: 'host.llm',
      availability: { status: 'available' },
      call_forms: [{ signature: 'await host.llm(request, options?)' }]
    })
    expect(hostSdkHelp.query('host.llm', { ...mainContext, capabilities })).toEqual(help)
    if (help.kind !== 'operation') throw new Error('expected operation help')
    expect(named(fields(help.request), 'prompt')).toMatchObject({
      type: 'string',
      required: true
    })
    expect(named(fields(help.options), 'maxConcurrency')).toMatchObject({
      type: 'integer',
      default: 2,
      range: '1..4'
    })
    expect(fields(help.returns, 'success_fields').map(({ name }) => name)).toEqual([
      'text',
      'model',
      'stopReason',
      'usage'
    ])
    expect(fields(help.returns, 'batch_error_fields').map(({ name }) => name)).toEqual(['error'])
    expect(
      fields(help.returns, 'usage_fields').map(({ name, required }) => ({ name, required }))
    ).toEqual([
      { name: 'inputTokens', required: true },
      { name: 'cacheTokens', required: true },
      { name: 'outputTokens', required: true },
      { name: 'cachedReadTokens', required: false },
      { name: 'cachedWriteTokens', required: false },
      { name: 'turnCount', required: false }
    ])
    expect(
      hostSdkHelp.query('llm', {
        ...mainContext,
        capabilities: { ...mainContext.capabilities, llm: false }
      })
    ).toMatchObject({ availability: { status: 'unavailable' } })
  })

  it('documents Main-only Project Session diagnostics through one namespace topic', () => {
    const capabilities = { ...mainContext.capabilities, sessions: true }
    const help = hostSdkHelp.query('sessions', { ...mainContext, capabilities })
    expect(help).toMatchObject({
      kind: 'operation',
      id: 'host.sessions',
      availability: { status: 'available' },
      call_forms: [
        { signature: 'await host.sessions.list(options?)' },
        { signature: 'await host.sessions.inspect(sessionId)' }
      ]
    })
    expect(hostSdkHelp.query('host.sessions', { ...mainContext, capabilities })).toEqual(help)
    expect(
      hostSdkHelp.query('sessions', {
        ...delegateContext,
        capabilities
      })
    ).toMatchObject({ availability: { status: 'unavailable' } })
  })

  it('keeps the published REPL subagent surface and Help registry in lockstep', () => {
    const source = readFileSync(resolve(process.cwd(), 'resources/notebook/repl_loop.js'), 'utf8')
    const match = source.match(/const subagentHostOperations = Object\.freeze\(\{([\s\S]*?)\n\}\)/)
    expect(match).not.toBeNull()
    const published = [...(match?.[1].matchAll(/^\s{2}([a-z][A-Za-z0-9]*):/gm) ?? [])]
      .map((entry) => `host.${entry[1]}`)
      .sort()
    expect(published).toEqual([...HOST_SDK_SUBAGENT_OPERATION_IDS])
  })

  it('describes delegate inputs and outputs as flat fields rather than a validation schema', () => {
    const canonical = operation('host.delegate')
    expect(hostSdkHelp.query('delegate', mainContext)).toEqual(canonical)

    expect(canonical.request).toMatchObject({ accepts: ['object', 'non_empty_array'] })
    const requestFields = fields(canonical.request)
    expect(requestFields.map(({ name }) => name)).toEqual([
      'task',
      'name',
      'profile',
      'inputs',
      'outputSchema'
    ])
    expect(named(requestFields, 'task')).toMatchObject({ type: 'string', required: true })
    expect(named(requestFields, 'name')).toMatchObject({ type: 'string', required: true })
    expect(named(requestFields, 'name').description).toMatch(/1–48.*emoji.*current branch/i)
    expect(named(requestFields, 'profile').description).toMatch(/omit.*inherit/i)
    expect(named(requestFields, 'inputs').description).toMatch(/immutable.*\.\/inputs\//i)
    expect(requestFields).not.toContainEqual(expect.objectContaining({ name: 'context' }))

    const optionFields = fields(canonical.options)
    expect(named(optionFields, 'wait')).toMatchObject({ type: 'boolean', default: true })
    expect(named(optionFields, 'timeoutSeconds')).toMatchObject({
      type: 'number',
      range: '0..1800'
    })

    expect(canonical.returns).toMatchObject({
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
      ]
    })
    const childFields = fields(canonical.returns, 'child_fields')
    expect(childFields.map(({ name }) => name)).toEqual([
      'frameId',
      'attemptId',
      'name',
      'agentName',
      'status',
      'terminalMessageId',
      'response',
      'artifactsCreated',
      'cancellationReason',
      'error',
      'structuredOutput',
      'structuredOutputUnsatisfied'
    ])
    expect(named(childFields, 'frameId')).toMatchObject({ type: 'string', required: true })
    expect(named(childFields, 'artifactsCreated')).toMatchObject({
      type: 'array',
      when: 'terminal'
    })

    const serialized = JSON.stringify(canonical)
    expect(serialized).not.toContain('"oneOf"')
    expect(serialized).not.toContain('"allOf"')
    expect(serialized).not.toContain('"properties"')
    expect(canonical).not.toHaveProperty('errors')
    expect(canonical.examples).toHaveLength(1)
    expect(canonical.constraints).toContainEqual(
      expect.stringMatching(/children.*collect.*stopChild/i)
    )
    expect(serialized.length).toBeLessThanOrEqual(3_200)
  })

  it('uses the same flat field-description shape for every operation topic', () => {
    for (const id of HOST_SDK_SUBAGENT_OPERATION_IDS) {
      const help = operation(id, id === 'host.submitOutput' ? 'delegate' : 'main')
      expect(Array.isArray((help.request as { fields?: unknown }).fields)).toBe(true)
      expect(Array.isArray((help.options as { fields?: unknown }).fields)).toBe(true)
      expect(help).not.toHaveProperty('errors')
      const serialized = JSON.stringify(help)
      expect(serialized).not.toContain('"oneOf"')
      expect(serialized).not.toContain('"allOf"')
      expect(serialized).not.toContain('"properties"')
      expect(serialized.length).toBeLessThanOrEqual(id === 'host.delegate' ? 3_200 : 3_600)
    }
  })

  it('keeps lifecycle operation fields sufficient for direct use', () => {
    const children = operation('children')
    expect(fields(children.request)).toEqual([
      expect.objectContaining({ name: 'frameIds', type: 'string[]', required: false })
    ])
    expect(fields(children.returns, 'item_fields').map(({ name }) => name)).toEqual([
      'frameId',
      'attemptId',
      'title',
      'name',
      'agentName',
      'status'
    ])
    expect(named(fields(children.returns, 'item_fields'), 'status').description).toContain(
      'awaiting_user'
    )

    const collect = operation('collect')
    expect(fields(collect.request)).toEqual([
      expect.objectContaining({ name: 'selectors', type: 'selector[]', required: true })
    ])
    expect(named(fields(collect.options), 'timeoutSeconds')).toMatchObject({
      default: 30,
      range: '0..1800'
    })
    expect(named(fields(collect.options), 'returnWhen')).toMatchObject({ default: 'all' })
    expect(collect.constraints.join(' ')).toContain('currently running')
    expect(collect.call_forms[0]?.signature).toBe('await host.collect(selectors, options?)')
    expect(collect.examples[0]?.code).toContain('{ frameId, attemptId }')

    const stop = operation('stopChild')
    expect(fields(stop.request)).toEqual([
      expect.objectContaining({ name: 'frameIds', type: 'string[]', required: true })
    ])
    expect(fields(stop.returns, 'item_fields').map(({ name }) => name)).toEqual([
      'frameId',
      'status'
    ])
    expect(stop.call_forms[0]?.signature).toBe('await host.stopChild(frameIds)')

    const send = operation('sendFrameMessage')
    expect(fields(send.options).map(({ name }) => name)).toEqual([
      'kind',
      'requestId',
      'replyToMessageId'
    ])
    expect(send.call_forms[0]?.signature).toBe(
      'await host.sendFrameMessage(target, message, options?)'
    )

    const receipt = operation('messageReceipt')
    expect(fields(receipt.options)).toEqual([
      expect.objectContaining({ name: 'timeoutSeconds', type: 'number', required: false })
    ])
    expect(receipt.examples[0]?.code).toContain('{ timeoutSeconds: 30 }')

    const resolveMessage = operation('resolveMessage')
    expect(fields(resolveMessage.request)).toEqual([
      expect.objectContaining({ name: 'messageId', type: 'string', required: true })
    ])

    const submitOutput = operation('submitOutput', 'delegate')
    expect(submitOutput.call_forms[0]?.signature).toBe('await host.submitOutput(value)')
    expect(submitOutput.constraints.join(' ')).toContain('mandatory')
    expect(submitOutput.constraints.join(' ')).toContain('ordinary final response')
  })

  it('describes reliable receipt routes and states without exhaustive unions', () => {
    for (const topic of ['sendFrameMessage', 'messageReceipt']) {
      const help = operation(topic)
      expect(help.returns).toMatchObject({
        discriminators: [
          { name: 'direction', values: ['to_child', 'to_parent'] },
          { name: 'disposition', values: ['message', 'continued'] },
          { name: 'status', values: ['queued', 'accepted', 'failed', 'uncertain'] }
        ]
      })
      expect(fields(help.returns).map(({ name }) => name)).toEqual([
        'requestId',
        'messageId',
        'sourceFrameId',
        'targetFrameId',
        'replyToMessageId',
        'queuedAt',
        'direction',
        'disposition',
        'targetAttemptId',
        'continuationAttemptId',
        'sourceAttemptId',
        'rootPromptMessageId',
        'status',
        'dispatchStartedAt',
        'acceptedAt',
        'evidence',
        'failedAt',
        'error',
        'uncertainAt',
        'deliveryMayHaveOccurred',
        'resolution',
        'newRequestRetrySafe',
        'sameRequestSafe'
      ])
    }
    expect(operation('resolveMessage').returns).toMatchObject({
      discriminators: [
        { name: 'direction', values: ['to_child', 'to_parent'] },
        { name: 'disposition', values: ['message', 'continued'] },
        { name: 'status', values: ['uncertain'] },
        { name: 'resolution', values: ['acknowledged'] }
      ]
    })
  })

  it('returns structured suggestions for unknown topics', () => {
    expect(hostSdkHelp.query('delegte', mainContext)).toEqual({
      kind: 'not_found',
      query: 'delegte',
      suggestions: ['host.delegate', 'host.collect', 'host.llm']
    })
    for (const unpublished of [
      'delegate.request',
      'delegate.errors',
      'continue_child',
      'acknowledge_message',
      'stop_children'
    ]) {
      expect(hostSdkHelp.query(unpublished, mainContext)).toMatchObject({
        kind: 'not_found',
        query: unpublished
      })
    }
    expect(hostSdkHelp.query('send_message', mainContext)).toMatchObject({
      kind: 'not_found',
      query: 'send_message'
    })
    for (const legacyTopic of [
      'stop_child',
      'send_frame_message',
      'message_receipt',
      'resolve_message',
      'submit_output'
    ]) {
      expect(hostSdkHelp.query(legacyTopic, mainContext)).toMatchObject({
        kind: 'not_found',
        query: legacyTopic
      })
    }
  })

  it('projects availability from trusted role and provisioning independently', () => {
    expect(hostSdkHelp.query('delegate', delegateContext)).toMatchObject({
      availability: {
        status: 'unavailable',
        reason: 'Nested delegation is unsupported for Delegate agents.'
      }
    })
    for (const id of HOST_SDK_SUBAGENT_OPERATION_IDS) {
      const operationName = id.slice('host.'.length) as keyof typeof provisioned
      const result = hostSdkHelp.query(id, {
        callerRole: operationName === 'submitOutput' ? 'delegate' : 'main',
        capabilities: { ...provisioned, [operationName]: false }
      })
      expect(result).toMatchObject({ availability: { status: 'unavailable' } })
    }
  })

  it('advertises reliable parent messaging to an authenticated Delegate', () => {
    expect(hostSdkHelp.query('sendFrameMessage', delegateContext)).toMatchObject({
      availability: { status: 'available' }
    })
    expect(hostSdkHelp.query('messageReceipt', delegateContext)).toMatchObject({
      availability: { status: 'available' }
    })
    expect(hostSdkHelp.query('resolveMessage', delegateContext)).toMatchObject({
      availability: {
        status: 'unavailable',
        reason: 'Only root Main can resolve uncertain delivery.'
      }
    })
  })

  it('keeps root-only topics discoverable but unavailable to a Delegate', () => {
    const rootCatalog = hostSdkHelp.query(undefined, mainContext)
    const childCatalog = hostSdkHelp.query(undefined, delegateContext)
    if (rootCatalog.kind !== 'catalog' || childCatalog.kind !== 'catalog') {
      throw new Error('expected catalogs')
    }
    expect(childCatalog.topics.map(({ id }) => id)).toEqual(rootCatalog.topics.map(({ id }) => id))
    for (const topic of ['delegate', 'children', 'collect', 'stopChild', 'resolveMessage']) {
      expect(hostSdkHelp.query(topic, delegateContext)).toMatchObject({
        availability: { status: 'unavailable' }
      })
    }
  })

  it('rejects invalid or oversized queries', () => {
    expect(() => hostSdkHelp.query(42, mainContext)).toThrow('host.help query must be a string')
    expect(() => hostSdkHelp.query('x'.repeat(129), mainContext)).toThrow(
      'host.help query must be at most 128 characters'
    )
  })
})
