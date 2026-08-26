import { describe, expect, it, vi } from 'vitest'

import type { CreateElicitationRequest, ElicitationSchema } from '@agentclientprotocol/sdk'

import { AcpElicitationOwner } from './elicitation-owner'

describe('AcpElicitationOwner', () => {
  it('keeps an attached choice durable when its provider connection is disposed', () => {
    const onProjection = vi.fn()
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'native-choice-1',
      onProjection
    })

    void owner.request(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        toolCallId: 'tool-native-choice-1',
        message: 'Choose an approach',
        requestedSchema: {
          type: 'object',
          properties: {
            question_0: {
              type: 'string',
              oneOf: [
                { const: 'Minimal', title: 'Minimal' },
                { const: 'Expanded', title: 'Expanded' }
              ]
            },
            question_0_custom: { type: 'string', title: 'Other' }
          }
        }
      },
      { sessionId: 'app-session-1' },
      { promptMessageId: 'prompt-1' }
    )

    expect(owner.getPendingRequests()).toEqual([
      expect.objectContaining({
        requestId: 'native-choice-1',
        durable: {
          kind: 'agent-user-choice',
          requestId: 'native-choice-1',
          promptMessageId: 'prompt-1'
        }
      })
    ])

    owner.dispose()

    expect(owner.getPendingRequests()).toEqual([])
    expect(onProjection).toHaveBeenCalledTimes(1)
    expect(onProjection).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ state: 'pending' })
    )
  })

  it('registers and resolves a detached durable choice without parking a protocol request', () => {
    const onProjection = vi.fn()
    const owner = new AcpElicitationOwner({ onProjection, now: () => 42 })

    const request = owner.requestDetached(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        toolCallId: 'tool-choice-1',
        message: 'Choose an approach',
        requestedSchema: {
          type: 'object',
          properties: {
            question_0: {
              type: 'string',
              oneOf: [
                { const: 'minimal', title: 'Minimal' },
                { const: 'expanded', title: 'Expanded' }
              ]
            }
          }
        }
      },
      { sessionId: 'app-session-1' },
      {
        kind: 'agent-user-choice',
        requestId: 'choice-1',
        promptMessageId: 'prompt-1'
      }
    )

    expect(request).toMatchObject({
      requestId: 'choice-1',
      sessionId: 'app-session-1',
      durable: {
        kind: 'agent-user-choice',
        requestId: 'choice-1',
        promptMessageId: 'prompt-1'
      }
    })
    expect(onProjection).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ state: 'pending', durable: request?.durable })
    )

    expect(
      owner.respond({
        requestId: 'choice-1',
        action: 'accept',
        answers: [{ fieldId: 'question_0', value: 'minimal' }]
      })
    ).toEqual({
      request,
      response: { action: 'accept', content: { question_0: 'minimal' } },
      detached: true
    })
    expect(onProjection).toHaveBeenLastCalledWith(
      request,
      expect.objectContaining({
        state: 'answered',
        respondedAt: 42,
        durable: request?.durable
      })
    )
  })

  it('appends another question to a pending detached durable choice', () => {
    const onProjection = vi.fn()
    const owner = new AcpElicitationOwner({ onProjection })
    const request = owner.requestDetached(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        toolCallId: 'tool-choice-1',
        message: 'Choose the stack',
        requestedSchema: {
          type: 'object',
          properties: {
            question_0: {
              type: 'string',
              title: 'Stack',
              description: 'Which stack should I use?',
              enum: ['Python', 'R']
            },
            question_0_custom: { type: 'string', title: 'Other' }
          }
        }
      },
      { sessionId: 'app-session-1' },
      { kind: 'agent-user-choice', requestId: 'choice-1' }
    )

    const appended = owner.appendDetached(request!.requestId, [
      {
        id: 'question_1',
        label: 'Output',
        description: 'Which output should I produce?',
        kind: 'single-select',
        options: [
          { value: 'Notebook', label: 'Notebook' },
          { value: 'Report', label: 'Report' }
        ]
      },
      { id: 'question_1_custom', label: 'Other', kind: 'text' }
    ])

    expect(appended?.fields).toHaveLength(4)
    expect(owner.getPendingRequests()).toEqual([appended])
    expect(onProjection).toHaveBeenLastCalledWith(
      appended,
      expect.objectContaining({
        state: 'pending',
        fields: expect.arrayContaining([
          expect.objectContaining({
            id: 'question_1',
            description: 'Which output should I produce?'
          })
        ])
      })
    )
  })

  it('rehydrates a detached durable choice and preserves it when the owner disconnects', () => {
    const onProjection = vi.fn()
    const owner = new AcpElicitationOwner({ onProjection })
    const request = {
      requestId: 'choice-1',
      sessionId: 'app-session-1',
      toolCallId: 'tool-choice-1',
      message: 'Choose an approach',
      fields: [
        {
          id: 'question_0',
          label: 'Approach',
          kind: 'single-select' as const,
          options: [
            { value: 'minimal', label: 'Minimal' },
            { value: 'expanded', label: 'Expanded' }
          ]
        }
      ],
      durable: { kind: 'agent-user-choice' as const, requestId: 'choice-1' }
    }

    expect(owner.restoreDetached(request)).toEqual(request)
    expect(owner.getPendingRequests()).toEqual([request])

    owner.dispose()

    expect(owner.getPendingRequests()).toEqual([])
    expect(onProjection).not.toHaveBeenCalled()
  })

  it('does not rehydrate a detached choice with duplicate field identities', () => {
    const owner = new AcpElicitationOwner({ onProjection: vi.fn() })

    expect(
      owner.restoreDetached({
        requestId: 'choice-1',
        sessionId: 'app-session-1',
        toolCallId: 'tool-choice-1',
        message: 'Choose an approach',
        fields: [
          { id: 'answer', label: 'First answer', kind: 'text' },
          { id: 'answer', label: 'Second answer', kind: 'text' }
        ],
        durable: { kind: 'agent-user-choice', requestId: 'choice-1' }
      })
    ).toBeUndefined()
    expect(owner.getPendingRequests()).toEqual([])
  })

  it('parks a form request and resumes it with validated typed content', async () => {
    const onProjection = vi.fn()
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'elicitation-1',
      onProjection
    })
    const request: CreateElicitationRequest = {
      mode: 'form',
      sessionId: 'agent-session-1',
      toolCallId: 'tool-ask-1',
      message: 'Choose an approach',
      requestedSchema: {
        type: 'object',
        properties: {
          approach: {
            type: 'string',
            title: 'Approach',
            oneOf: [
              {
                const: 'minimal',
                title: 'Minimal change',
                description: 'Reuse the existing activity model.'
              }
            ]
          },
          attempts: { type: 'integer', title: 'Attempts', minimum: 1, maximum: 3 }
        },
        required: ['approach']
      }
    }

    const result = owner.request(request, { sessionId: 'app-session-1' })

    expect(owner.getPendingRequests()).toEqual([
      expect.objectContaining({
        requestId: 'elicitation-1',
        sessionId: 'app-session-1',
        toolCallId: 'tool-ask-1',
        message: 'Choose an approach',
        fields: [
          expect.objectContaining({
            id: 'approach',
            kind: 'single-select',
            required: true,
            options: [
              {
                value: 'minimal',
                label: 'Minimal change',
                description: 'Reuse the existing activity model.'
              }
            ]
          }),
          expect.objectContaining({
            id: 'attempts',
            kind: 'integer',
            minimum: 1,
            maximum: 3
          })
        ]
      })
    ])
    expect(onProjection).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'app-session-1', toolCallId: 'tool-ask-1' }),
      expect.objectContaining({ state: 'pending' })
    )

    owner.respond({
      requestId: 'elicitation-1',
      action: 'accept',
      answers: [
        { fieldId: 'approach', value: 'minimal' },
        { fieldId: 'attempts', value: 2 }
      ]
    })

    await expect(result).resolves.toEqual({
      action: 'accept',
      content: { approach: 'minimal', attempts: 2 }
    })
    expect(owner.getPendingRequests()).toEqual([])
    expect(onProjection).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'app-session-1', toolCallId: 'tool-ask-1' }),
      expect.objectContaining({
        state: 'answered',
        answers: [
          { fieldId: 'approach', value: 'minimal' },
          { fieldId: 'attempts', value: 2 }
        ]
      })
    )
  })

  it('does not expose schema defaults that Main would reject as submitted values', () => {
    let sequence = 0
    const owner = new AcpElicitationOwner({
      createRequestId: () => `elicitation-${++sequence}`,
      onProjection: vi.fn()
    })
    const properties: ElicitationSchema['properties'][] = [
      {
        value: {
          type: 'string',
          enum: ['minimal', 'expanded'],
          default: 'unsupported'
        }
      },
      { value: { type: 'integer', minimum: 1, maximum: 3, default: 1.5 } },
      { value: { type: 'number', minimum: 1, maximum: 3, default: 4 } },
      { value: { type: 'string', format: 'email', default: 'not-an-email' } },
      {
        value: {
          type: 'array',
          items: { type: 'string', enum: ['alpha', 'beta'] },
          default: ['unsupported']
        }
      }
    ]

    for (const property of properties) {
      void owner.request(
        {
          mode: 'form',
          sessionId: 'agent-session-1',
          toolCallId: `tool-ask-${sequence + 1}`,
          message: 'Choose a value',
          requestedSchema: { type: 'object', properties: property }
        },
        { sessionId: 'app-session-1' }
      )
    }

    expect(owner.getPendingRequests().map((request) => request.fields[0].defaultValue)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    ])
    owner.dispose()
  })

  it('cancels only requests owned by the selected session', async () => {
    let sequence = 0
    const owner = new AcpElicitationOwner({
      createRequestId: () => `elicitation-${++sequence}`,
      onProjection: vi.fn()
    })
    const form = (sessionId: string): CreateElicitationRequest => ({
      mode: 'form',
      sessionId,
      toolCallId: `tool-${sessionId}`,
      message: 'Continue?',
      requestedSchema: {
        type: 'object',
        properties: { answer: { type: 'boolean', title: 'Continue' } }
      }
    })
    const first = owner.request(form('agent-session-1'), { sessionId: 'app-session-1' })
    const second = owner.request(form('agent-session-2'), { sessionId: 'app-session-2' })

    owner.cancelForSession('app-session-1')

    await expect(first).resolves.toEqual({ action: 'cancel' })
    expect(owner.getPendingRequests()).toEqual([
      expect.objectContaining({ requestId: 'elicitation-2', sessionId: 'app-session-2' })
    ])

    owner.respond({ requestId: 'elicitation-2', action: 'decline' })
    await expect(second).resolves.toEqual({ action: 'decline' })
  })

  it('does not orphan a request when publishing the pending projection fails', async () => {
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'elicitation-1',
      onProjection: () => {
        throw new Error('observer failed')
      }
    })

    const result = owner.request(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        toolCallId: 'tool-ask-1',
        message: 'Continue?',
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'boolean', title: 'Continue' } }
        }
      },
      { sessionId: 'app-session-1' }
    )

    await expect(result).resolves.toEqual({ action: 'cancel' })
    expect(owner.getPendingRequests()).toEqual([])
  })

  it('resolves the Agent response when publishing the terminal projection fails', async () => {
    const onProjection = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('observer failed')
      })
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'elicitation-1',
      onProjection
    })
    const result = owner.request(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        toolCallId: 'tool-ask-1',
        message: 'Continue?',
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'boolean', title: 'Continue' } }
        }
      },
      { sessionId: 'app-session-1' }
    )

    expect(() => owner.respond({ requestId: 'elicitation-1', action: 'decline' })).not.toThrow()
    await expect(result).resolves.toEqual({ action: 'decline' })
    expect(owner.getPendingRequests()).toEqual([])
  })

  it('declines a form that cannot be projected onto a tool activity', async () => {
    const onProjection = vi.fn()
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'elicitation-1',
      onProjection
    })

    const result = owner.request(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        message: 'Continue?',
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'boolean', title: 'Continue' } }
        }
      },
      { sessionId: 'app-session-1' }
    )

    await expect(result).resolves.toEqual({ action: 'decline' })
    expect(owner.getPendingRequests()).toEqual([])
    expect(onProjection).not.toHaveBeenCalled()
  })

  it('declines forms that exceed the bounded renderer projection', async () => {
    const onProjection = vi.fn()
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'elicitation-1',
      onProjection
    })

    const result = owner.request(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        toolCallId: 'tool-ask-1',
        message: 'Choose values',
        requestedSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [
              `field-${index}`,
              { type: 'string', title: `Field ${index}` }
            ])
          )
        }
      },
      { sessionId: 'app-session-1' }
    )

    await expect(result).resolves.toEqual({ action: 'decline' })
    expect(owner.getPendingRequests()).toEqual([])
    expect(onProjection).not.toHaveBeenCalled()
  })

  it('rejects accepted values that exceed the response bound', () => {
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'elicitation-1',
      onProjection: vi.fn()
    })
    void owner.request(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        toolCallId: 'tool-ask-1',
        message: 'Describe the approach',
        requestedSchema: {
          type: 'object',
          properties: { approach: { type: 'string', title: 'Approach' } }
        }
      },
      { sessionId: 'app-session-1' }
    )

    expect(() =>
      owner.respond({
        requestId: 'elicitation-1',
        action: 'accept',
        answers: [{ fieldId: 'approach', value: 'x'.repeat(4_001) }]
      })
    ).toThrow('Invalid structured input response')
    owner.dispose()
  })

  it('declines form constraints it cannot safely revalidate', async () => {
    const onProjection = vi.fn()
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'elicitation-1',
      onProjection
    })
    const result = owner.request(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        toolCallId: 'tool-ask-1',
        message: 'Enter a code',
        requestedSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', title: 'Code', pattern: '^[A-Z]+$' }
          }
        }
      },
      { sessionId: 'app-session-1' }
    )

    const pending = owner.getPendingRequests()
    owner.dispose()

    expect(pending).toEqual([])
    await expect(result).resolves.toEqual({ action: 'decline' })
    expect(onProjection).not.toHaveBeenCalled()
  })

  it('cancels a form containing an unknown future field type', async () => {
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'elicitation-1',
      onProjection: vi.fn()
    })

    await expect(
      owner.request(
        {
          mode: 'form',
          sessionId: 'agent-session-1',
          toolCallId: 'tool-ask-1',
          message: 'Choose a value',
          requestedSchema: {
            type: 'object',
            properties: { value: { type: 'future-type' } }
          }
        },
        { sessionId: 'app-session-1' }
      )
    ).resolves.toEqual({ action: 'cancel' })

    await expect(
      owner.request(
        {
          mode: 'form',
          sessionId: 'agent-session-1',
          toolCallId: 'tool-ask-2',
          message: 'Choose another value',
          requestedSchema: {
            type: 'object',
            properties: { value: { type: ['string', 'null'] } as never }
          }
        },
        { sessionId: 'app-session-1' }
      )
    ).resolves.toEqual({ action: 'cancel' })
  })

  it('revalidates formatted strings before resuming the Agent', () => {
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'elicitation-1',
      onProjection: vi.fn()
    })
    void owner.request(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        toolCallId: 'tool-ask-1',
        message: 'Enter contact details',
        requestedSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', title: 'Email', format: 'email' },
            timestamp: { type: 'string', title: 'Timestamp', format: 'date-time' }
          }
        }
      },
      { sessionId: 'app-session-1' }
    )

    expect(() =>
      owner.respond({
        requestId: 'elicitation-1',
        action: 'accept',
        answers: [{ fieldId: 'email', value: 'not an email' }]
      })
    ).toThrow('Invalid structured input response')

    expect(() =>
      owner.respond({
        requestId: 'elicitation-1',
        action: 'accept',
        answers: [{ fieldId: 'timestamp', value: '2026-08-02T12:00' }]
      })
    ).toThrow('Invalid structured input response')
    owner.dispose()
  })

  it('declines forms whose constraints cannot produce a bounded valid answer', async () => {
    let sequence = 0
    const owner = new AcpElicitationOwner({
      createRequestId: () => `elicitation-${++sequence}`,
      onProjection: vi.fn()
    })
    const request = (
      property: ElicitationSchema['properties']
    ): ReturnType<AcpElicitationOwner['request']> =>
      owner.request(
        {
          mode: 'form',
          sessionId: 'agent-session-1',
          toolCallId: `tool-ask-${sequence}`,
          message: 'Enter a value',
          requestedSchema: { type: 'object', properties: property }
        },
        { sessionId: 'app-session-1' }
      )

    await expect(request({ value: { type: 'string', minLength: 4_001 } })).resolves.toEqual({
      action: 'decline'
    })
    await expect(request({ value: { type: 'number', minimum: 2, maximum: 1 } })).resolves.toEqual({
      action: 'decline'
    })
    await expect(
      request({
        value: {
          type: 'array',
          minItems: 2,
          items: { type: 'string', enum: ['only-option'] }
        }
      })
    ).resolves.toEqual({ action: 'decline' })
  })

  it('declines required fields whose only schema-valid value is empty', async () => {
    const owner = new AcpElicitationOwner({
      createRequestId: () => 'elicitation-1',
      onProjection: vi.fn()
    })
    const result = owner.request(
      {
        mode: 'form',
        sessionId: 'agent-session-1',
        toolCallId: 'tool-ask-1',
        message: 'Enter a value',
        requestedSchema: {
          type: 'object',
          properties: { value: { type: 'string', maxLength: 0 } },
          required: ['value']
        }
      },
      { sessionId: 'app-session-1' }
    )

    const pending = owner.getPendingRequests()
    owner.dispose()

    expect(pending).toEqual([])
    await expect(result).resolves.toEqual({ action: 'decline' })
  })
})
