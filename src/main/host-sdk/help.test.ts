import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { HOST_SDK_SUBAGENT_OPERATION_IDS, hostSdkHelp } from './help'

const provisioned = Object.fromEntries(
  HOST_SDK_SUBAGENT_OPERATION_IDS.map((id) => [id.slice('host.'.length), true])
) as Record<
  (typeof HOST_SDK_SUBAGENT_OPERATION_IDS)[number] extends `host.${infer Op}` ? Op : never,
  boolean
>
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
    expect(catalog.topics.map(({ id }) => id)).toEqual([...HOST_SDK_SUBAGENT_OPERATION_IDS])
    expect(JSON.stringify(catalog).length).toBeLessThanOrEqual(2_500)
  })

  it('keeps the published REPL subagent surface and Help registry in lockstep', () => {
    const source = readFileSync(resolve(process.cwd(), 'resources/notebook/repl_loop.js'), 'utf8')
    const match = source.match(/const subagentHostOperations = Object\.freeze\(\{([\s\S]*?)\n\}\)/)
    expect(match).not.toBeNull()
    const published = [...(match?.[1].matchAll(/^\s{2}([a-z_]+):/gm) ?? [])]
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
      'output_schema'
    ])
    expect(named(requestFields, 'task')).toMatchObject({ type: 'string', required: true })
    expect(named(requestFields, 'name')).toMatchObject({ type: 'string', required: true })
    expect(named(requestFields, 'name').description).toMatch(/1–48.*emoji.*current branch/i)
    expect(named(requestFields, 'profile').description).toMatch(/omit.*inherit/i)
    expect(named(requestFields, 'inputs').description).toMatch(/immutable.*\.\/inputs\//i)
    expect(requestFields).not.toContainEqual(expect.objectContaining({ name: 'context' }))

    const optionFields = fields(canonical.options)
    expect(named(optionFields, 'wait')).toMatchObject({ type: 'boolean', default: true })
    expect(named(optionFields, 'timeout_seconds')).toMatchObject({
      type: 'number',
      range: '0..1800'
    })

    expect(canonical.returns).toMatchObject({
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
      ]
    })
    const childFields = fields(canonical.returns, 'child_fields')
    expect(childFields.map(({ name }) => name)).toEqual([
      'frame_id',
      'attempt_id',
      'name',
      'agent_name',
      'status',
      'terminal_message_id',
      'response',
      'artifacts_created',
      'cancellation_reason',
      'error',
      'structured_output',
      'structured_output_unsatisfied'
    ])
    expect(named(childFields, 'frame_id')).toMatchObject({ type: 'string', required: true })
    expect(named(childFields, 'artifacts_created')).toMatchObject({
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
      expect.stringMatching(/children.*collect.*stop_child/i)
    )
    expect(serialized.length).toBeLessThanOrEqual(3_200)
  })

  it('uses the same flat field-description shape for every operation topic', () => {
    for (const id of HOST_SDK_SUBAGENT_OPERATION_IDS) {
      const help = operation(id, id === 'host.submit_output' ? 'delegate' : 'main')
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
      expect.objectContaining({ name: 'frame_ids', type: 'string[]', required: false })
    ])
    expect(fields(children.returns, 'item_fields').map(({ name }) => name)).toEqual([
      'frame_id',
      'attempt_id',
      'title',
      'name',
      'agent_name',
      'status'
    ])
    expect(named(fields(children.returns, 'item_fields'), 'status').description).toContain(
      'awaiting_user'
    )

    const collect = operation('collect')
    expect(fields(collect.request)).toEqual([
      expect.objectContaining({ name: 'selectors', type: 'selector[]', required: true })
    ])
    expect(named(fields(collect.options), 'timeout_seconds')).toMatchObject({
      default: 30,
      range: '0..1800'
    })

    const stop = operation('stop_child')
    expect(fields(stop.request)).toEqual([
      expect.objectContaining({ name: 'frame_ids', type: 'string[]', required: true })
    ])
    expect(fields(stop.returns, 'item_fields').map(({ name }) => name)).toEqual([
      'frame_id',
      'status'
    ])
  })

  it('describes reliable receipt routes and states without exhaustive unions', () => {
    for (const topic of ['send_frame_message', 'message_receipt']) {
      const help = operation(topic)
      expect(help.returns).toMatchObject({
        discriminators: [
          { name: 'direction', values: ['to_child', 'to_parent'] },
          { name: 'disposition', values: ['message', 'continued'] },
          { name: 'status', values: ['queued', 'accepted', 'failed', 'uncertain'] }
        ]
      })
      expect(fields(help.returns).map(({ name }) => name)).toEqual([
        'request_id',
        'message_id',
        'source_frame_id',
        'target_frame_id',
        'reply_to_message_id',
        'queued_at',
        'direction',
        'disposition',
        'target_attempt_id',
        'continuation_attempt_id',
        'source_attempt_id',
        'root_prompt_message_id',
        'status',
        'dispatch_started_at',
        'accepted_at',
        'evidence',
        'failed_at',
        'error',
        'uncertain_at',
        'delivery_may_have_occurred',
        'resolution',
        'new_request_retry_safe',
        'same_request_safe'
      ])
    }
    expect(operation('resolve_message').returns).toMatchObject({
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
      suggestions: ['host.delegate', 'host.collect', 'host.children']
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
        callerRole: operationName === 'submit_output' ? 'delegate' : 'main',
        capabilities: { ...provisioned, [operationName]: false }
      })
      expect(result).toMatchObject({ availability: { status: 'unavailable' } })
    }
  })

  it('advertises reliable parent messaging to an authenticated Delegate', () => {
    expect(hostSdkHelp.query('send_frame_message', delegateContext)).toMatchObject({
      availability: { status: 'available' }
    })
    expect(hostSdkHelp.query('message_receipt', delegateContext)).toMatchObject({
      availability: { status: 'available' }
    })
    expect(hostSdkHelp.query('resolve_message', delegateContext)).toMatchObject({
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
    for (const topic of ['delegate', 'children', 'collect', 'stop_child', 'resolve_message']) {
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
