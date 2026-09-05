import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { createDeterministicDelegateExecution } from '../delegation/deterministic-execution'
import { createInMemoryDelegatedWorkRecords } from '../delegation/durable-delegated-work'
import { createTestDurableDelegatedWork } from '../delegation/durable-delegated-work-test-fixture'

import {
  COLLECT_AGENT_CONTRACT,
  DELEGATE_AGENT_CONTRACT,
  parseCollectRpcCall,
  parseDelegateRpcCall
} from './delegate-contract'

describe('Agent-facing delegate contract', () => {
  it('owns a machine-readable single-request or non-empty-array input schema', () => {
    const [singleRequest, requestArray] = DELEGATE_AGENT_CONTRACT.request.oneOf

    expect(singleRequest).toMatchObject({
      type: 'object',
      required: ['task', 'name'],
      properties: {
        task: { type: 'string', minLength: 1 },
        name: {
          type: 'string',
          minLength: 1,
          maxCodePoints: 48,
          description: expect.stringMatching(/required/i)
        },
        profile: { type: 'string', minLength: 1 },
        inputs: {
          type: 'array',
          items: { type: 'string', minLength: 1, identity: 'immutable_upload_or_artifact_version' }
        },
        outputSchema: expect.objectContaining({
          description: expect.stringMatching(/2020-12.*host\.submitOutput/s)
        })
      }
    })
    expect(requestArray).toEqual({ type: 'array', minItems: 1, maxItems: 4, items: singleRequest })
    expect(singleRequest.properties).not.toHaveProperty('context')
    expect(singleRequest.properties).not.toHaveProperty('output_schema')
    expect(singleRequest.additionalProperties).toBe(false)
    expect(DELEGATE_AGENT_CONTRACT.options).toMatchObject({
      additionalProperties: false,
      properties: {
        timeoutSeconds: { minimum: 0, maximum: 1800 }
      }
    })
    expect(DELEGATE_AGENT_CONTRACT.options.properties).not.toHaveProperty('timeout_seconds')
    expect(DELEGATE_AGENT_CONTRACT.returns.oneOf[0].properties.children.items.required).toContain(
      'frameId'
    )
    expect(singleRequest.properties.profile.description).toContain(
      'Omit to inherit the authenticated parent Specialist'
    )
    expect(singleRequest.properties.name.description).toMatch(/emoji.*not allowed/i)
    expect(singleRequest.properties.name.description).toMatch(/current active root Message Branch/i)
    expect(singleRequest.properties.name.description).toMatch(
      /NFC-equivalent.*whitespace-collapsed.*lowercase-equivalent/i
    )
    expect(singleRequest.properties.name.description).toMatch(/never derived.*suffixed.*renamed/i)
    expect(DELEGATE_AGENT_CONTRACT.errors.conditions).toContainEqual(
      expect.stringMatching(/missing.*empty.*newline.*emoji.*48.*current-branch.*retry/i)
    )
  })

  it('parses private snake-case wire requests without replacing domain admission validation', () => {
    expect(
      parseDelegateRpcCall({
        request: [{ task: 'Audit', inputs: ['upload-version-1'] }],
        options: { wait: false }
      })
    ).toEqual({
      request: [{ task: 'Audit', inputs: ['upload-version-1'] }],
      options: { wait: false }
    })
    expect(() => parseDelegateRpcCall({ request: [] })).toThrow(
      'host.delegate request must be one object or a non-empty object array'
    )
    expect(
      parseDelegateRpcCall({
        request: { task: 'Observe' },
        options: { timeout_seconds: 0 }
      })
    ).toEqual({ request: { task: 'Observe' }, options: { timeoutSeconds: 0 } })
    expect(parseDelegateRpcCall({ request: { task: '' } })).toEqual({
      request: { task: '' },
      options: {}
    })
    expect(
      parseDelegateRpcCall({ request: { task: 'Extract', output_schema: { type: 'number' } } })
    ).toEqual({
      request: { task: 'Extract', outputSchema: { type: 'number' } },
      options: {}
    })
    expect(() => parseDelegateRpcCall({ request: 'Audit' })).toThrow(
      'host.delegate request must be one object or a non-empty object array'
    )
    expect(() =>
      parseDelegateRpcCall({ request: { task: 'Audit' }, options: { wait: 'no' } })
    ).toThrow('host.delegate options.wait must be true or false.')
    expect(() =>
      parseDelegateRpcCall({
        request: { task: 'Audit' },
        options: { wait: false, timeout_seconds: 1 }
      })
    ).toThrow('omit timeout_seconds or set wait:true')
    expect(() =>
      parseDelegateRpcCall({ request: { task: 'Extract', outputSchema: { type: 'number' } } })
    ).toThrow('private RPC requests use output_schema')
    expect(() =>
      parseDelegateRpcCall({
        request: { task: 'Extract', output_schema: {}, outputSchema: {} }
      })
    ).toThrow('private RPC requests use output_schema')
    expect(() =>
      parseDelegateRpcCall({
        request: { task: 'Observe' },
        options: { timeout_seconds: 0, timeoutSeconds: 0 }
      })
    ).toThrow('private RPC options use timeout_seconds')
  })
})

describe('Agent-facing collect contract', () => {
  it('publishes camel-case selector, option, and return fields', () => {
    const explicitSelector = COLLECT_AGENT_CONTRACT.selectors.items.oneOf[1]
    expect(explicitSelector).toMatchObject({
      additionalProperties: false,
      required: ['frameId', 'attemptId'],
      properties: { frameId: { type: 'string' }, attemptId: { type: 'string' } }
    })
    expect(explicitSelector.properties).not.toHaveProperty('frame_id')
    expect(explicitSelector.properties).not.toHaveProperty('attempt_id')
    expect(COLLECT_AGENT_CONTRACT.options.properties.timeoutSeconds).toMatchObject({
      minimum: 0,
      maximum: 1800,
      default: 30
    })
    expect(COLLECT_AGENT_CONTRACT.options.properties.returnWhen).toMatchObject({
      enum: ['all', 'any'],
      default: 'all'
    })
    expect(COLLECT_AGENT_CONTRACT.options.properties).not.toHaveProperty('timeout_seconds')
    expect(COLLECT_AGENT_CONTRACT.options.additionalProperties).toBe(false)
    expect(COLLECT_AGENT_CONTRACT.returns.items.oneOf[0].required).toContain('frameId')
    expect(COLLECT_AGENT_CONTRACT.returns.items.oneOf[0].required).toContain('attemptId')
  })

  it('parses private snake-case wire selectors with bounded options', () => {
    expect(
      parseCollectRpcCall({
        selectors: ['frame-1', { frame_id: 'frame-2', attempt_id: 'attempt-2' }],
        options: { timeout_seconds: 0, return_when: 'any' }
      })
    ).toEqual({
      selectors: ['frame-1', { frameId: 'frame-2', attemptId: 'attempt-2' }],
      options: { timeoutSeconds: 0, returnWhen: 'any' }
    })
    for (const invalid of [-1, 1801, Number.NaN, Number.POSITIVE_INFINITY, '30']) {
      expect(() =>
        parseCollectRpcCall({ selectors: ['frame-1'], options: { timeout_seconds: invalid } })
      ).toThrow('finite number from 0 through 1800')
    }
    expect(() =>
      parseCollectRpcCall({ selectors: [{ frameId: 'frame-1', attemptId: 'attempt-1' }] })
    ).toThrow('private RPC selectors use {frame_id, attempt_id}')
    expect(() =>
      parseCollectRpcCall({
        selectors: [
          {
            frame_id: 'frame-1',
            attempt_id: 'attempt-1',
            frameId: 'frame-1',
            attemptId: 'attempt-1'
          }
        ]
      })
    ).toThrow('private RPC selectors use {frame_id, attempt_id}')
    expect(() =>
      parseCollectRpcCall({
        selectors: ['frame-1'],
        options: { timeout_seconds: 0, timeoutSeconds: 0 }
      })
    ).toThrow('private RPC options use timeout_seconds')
    expect(() =>
      parseCollectRpcCall({ selectors: ['frame-1'], options: { return_when: 'first' } })
    ).toThrow('return_when must be all or any')
  })
})

it('D03 collect schema accepts the actual pending-question observation', async () => {
  const caller = {
    session: { projectId: 'project-1', sessionId: 'session-1' },
    frameId: 'root',
    role: 'main' as const,
    originMessageId: 'origin',
    toolInvocationId: 'delegate'
  }
  const records = createInMemoryDelegatedWorkRecords({
    session: caller.session,
    rootFrameId: caller.frameId,
    originMessageId: caller.originMessageId
  })
  const execution = createDeterministicDelegateExecution()
  const work = createTestDurableDelegatedWork({ execution, records })
  const receipt = await work.delegate(caller, { task: 'Ask', name: 'Question' }, { wait: false })
  await expect.poll(() => execution.controls()).toHaveLength(1)
  const control = execution.controls()[0]
  await work.requestUserInput(
    {
      ...caller,
      role: 'delegate',
      frameId: control.input.frameId,
      attemptId: control.input.attemptId,
      originMessageId: control.input.turn!.promptMessageId,
      toolInvocationId: 'ask'
    },
    {
      sessionId: caller.session.sessionId,
      questions: [{ question: 'Which cohort?', options: [{ label: 'Strict' }, { label: 'Broad' }] }]
    }
  )
  control.complete('Waiting for your answer')
  await expect.poll(() => execution.releasedFrames()).toHaveLength(1)
  const observation = await work.collect(caller, [receipt.children[0]], { timeoutSeconds: 0 })
  await work.stopSession(caller.session)
  expect(observation[0].status).toBe('awaiting_user')
  // Descriptive contract extensions such as optional/discriminator are not JSON Schema keywords.
  const validate = new Ajv2020({ strict: false }).compile(COLLECT_AGENT_CONTRACT.returns)
  expect(validate(observation), JSON.stringify(validate.errors)).toBe(true)
})
