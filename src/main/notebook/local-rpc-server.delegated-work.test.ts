import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createArtifactVersionLocator,
  parseArtifactVersionLocator
} from '../../shared/artifact-provenance'
import type { HostArtifactCatalogItem } from '../../shared/project-files'
import { createUploadVersionReference } from '../../shared/uploads'
import { createDeterministicDelegateExecution } from '../delegation/deterministic-execution'
import { createInMemoryDelegatedWorkRecords } from '../delegation/durable-delegated-work'
import { DELEGATION_DISABLED_MESSAGE } from '../delegation/durable-delegated-work-error'
import { createTestDurableDelegatedWork as createDurableDelegatedWork } from '../delegation/durable-delegated-work-test-fixture'
import { NotebookLocalRpcServer } from './local-rpc-server'

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('authenticated delegatedWorkCall route', () => {
  const catalogItem = (
    overrides: Partial<HostArtifactCatalogItem> = {}
  ): HostArtifactCatalogItem => ({
    source: 'artifact',
    sourceFileId: 'artifact-1',
    versionId: 'artifact-version-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    filename: 'result.csv',
    sizeBytes: 12,
    sortAtMs: 1,
    createdAt: '2026-08-28T00:00:00.000Z',
    sourceFileCreatedAt: '2026-08-28T00:00:00.000Z',
    rootFrameId: 'root-frame',
    agentFrameId: 'child-frame',
    ...overrides
  })

  it('projects authoritative Session delegation policy without disabling existing-child operations', async () => {
    let delegationAllowed = true
    const work = {
      isDelegationAllowed: vi.fn(async () => delegationAllowed),
      delegate: vi.fn(),
      children: vi.fn(),
      collect: vi.fn(),
      stopChildren: vi.fn(),
      sendMessage: vi.fn(),
      messageReceipt: vi.fn(),
      resolveMessage: vi.fn()
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection('session-1', 'project-1', 'root-frame')
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1',
      originatingUserMessageId: 'message-1'
    })
    const call = async (
      method: 'capabilitiesCall' | 'hostSdkHelp',
      query?: string
    ): Promise<unknown> => {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method, params: query === undefined ? {} : { query } })
      })
      expect(response.status).toBe(200)
      return response.json()
    }

    await expect(call('capabilitiesCall')).resolves.toMatchObject({
      result: { delegate: true, children: true, collect: true, stopChild: true }
    })
    await expect(call('hostSdkHelp', 'delegate')).resolves.toMatchObject({
      result: { availability: { status: 'available' } }
    })

    delegationAllowed = false
    await expect(call('capabilitiesCall')).resolves.toMatchObject({
      result: {
        delegate: false,
        children: true,
        collect: true,
        stopChild: true,
        sendFrameMessage: true,
        messageReceipt: true,
        resolveMessage: true
      }
    })
    const catalog = (await call('hostSdkHelp')) as {
      result: { topics: Array<{ id: string; availability: { status: string } }> }
    }
    expect(catalog.result.topics).toContainEqual(
      expect.objectContaining({
        id: 'host.delegate',
        availability: { status: 'unavailable' }
      })
    )
    await expect(call('hostSdkHelp', 'delegate')).resolves.toMatchObject({
      result: {
        availability: {
          status: 'unavailable',
          reason: DELEGATION_DISABLED_MESSAGE
        }
      }
    })
    expect(work.isDelegationAllowed).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1'
    })

    endInvocation()
    connection.release()
  })

  it('lets only a delegated control-kernel capability submit output for its bound Attempt', async () => {
    const submitOutput = vi.fn(async () => ({ accepted: true as const }))
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate: vi.fn(), submitOutput }
    })
    const main = await server.issueControlConnection('session-1', 'project-1', 'root-frame')
    const child = await server.issueControlConnection('session-1', 'project-1', 'child-frame', {
      role: 'delegate',
      attemptId: 'attempt-1'
    })
    const call = (token: string): Promise<Response> =>
      fetch(child.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'delegatedOutputCall',
          params: { value: { count: 3 }, frame_id: 'forged-frame' }
        })
      })

    expect((await call(main.token)).status).toBe(403)
    expect((await call(child.token)).status).toBe(403)
    const endInvocation = child.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1',
      originatingTurnId: 'prompt-message-1',
      originatingUserMessageId: 'prompt-message-1',
      attachmentIds: [],
      artifactIds: []
    })
    const accepted = await call(child.token)
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toEqual({ result: { accepted: true } })
    expect(submitOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { projectId: 'project-1', sessionId: 'session-1' },
        frameId: 'child-frame',
        attemptId: 'attempt-1',
        role: 'delegate',
        originMessageId: 'prompt-message-1'
      }),
      { count: 3 }
    )
    endInvocation()
    main.release()
    child.release()
  })

  it('keeps delegated help unavailable until its authenticated route is ready', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate: vi.fn() }
    })
    const main = await server.issueControlConnection('session-1', 'project-1', 'root-frame')
    const child = await server.issueControlConnection('session-1', 'project-1', 'child-frame', {
      role: 'delegate',
      attemptId: 'attempt-1'
    })

    const ask = async (
      endpoint: string,
      token: string,
      callerRole: string,
      query?: string
    ): Promise<unknown> => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'hostSdkHelp',
          params: { query, caller_role: callerRole }
        })
      })
      expect(response.status).toBe(200)
      return response.json()
    }

    await expect(ask(main.endpoint, main.token, 'delegate', 'delegate')).resolves.toMatchObject({
      result: {
        kind: 'operation',
        availability: {
          status: 'unavailable',
          reason: 'host.delegate is not provisioned for this Session.'
        }
      }
    })
    await expect(ask(child.endpoint, child.token, 'main', 'delegate')).resolves.toMatchObject({
      result: {
        kind: 'operation',
        availability: {
          status: 'unavailable',
          reason: 'Nested delegation is unsupported for Delegate agents.'
        }
      }
    })
    const partialCatalog = (await ask(main.endpoint, main.token, 'main', undefined)) as {
      result: { topics: Array<{ id: string; availability: { status: string } }> }
    }
    expect(
      Object.fromEntries(
        partialCatalog.result.topics.map(({ id, availability }) => [id, availability.status])
      )
    ).toEqual({
      'host.children': 'unavailable',
      'host.collect': 'unavailable',
      'host.currentModel': 'unavailable',
      'host.delegate': 'unavailable',
      'host.listModels': 'unavailable',
      'host.llm': 'unavailable',
      'host.messageReceipt': 'unavailable',
      'host.resolveMessage': 'unavailable',
      'host.sessions': 'unavailable',
      'host.sendFrameMessage': 'unavailable',
      'host.stopChild': 'unavailable',
      'host.submitOutput': 'unavailable',
      'host.viewImage': 'unavailable'
    })
    await expect(
      fetch(child.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${child.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'hostSdkHelp',
          params: { query: 'sendFrameMessage', caller_role: 'main' }
        })
      }).then((response) => response.json())
    ).resolves.toMatchObject({
      result: {
        id: 'host.sendFrameMessage',
        availability: {
          status: 'unavailable',
          reason: 'host.sendFrameMessage is not provisioned for this Session.'
        }
      }
    })

    main.release()
    child.release()
  })

  it('keeps delegated-work RPC diagnostics on the private snake_case contract', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: {
        delegate: vi.fn(),
        children: vi.fn(),
        stopChildren: vi.fn(),
        sendMessage: vi.fn()
      }
    })
    const connection = await server.issueControlConnection(
      'session-1',
      'project-1',
      'child-frame',
      { role: 'delegate', attemptId: 'attempt-1' }
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1',
      originatingUserMessageId: 'message-1'
    })
    const call = async (
      params: Record<string, unknown>,
      method = 'delegatedWorkCall'
    ): Promise<unknown> => {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method, params })
      })
      expect(response.status).toBe(500)
      return response.json()
    }

    await expect(call({ value: 'done' }, 'delegatedOutputCall')).resolves.toEqual({
      error: 'host.submit_output is not configured.'
    })
    await expect(
      call({
        op: 'send_message',
        target: 'child-frame',
        message: 'hello',
        options: { request_id: 42 }
      })
    ).resolves.toEqual({ error: 'host.send_frame_message request_id must be a string.' })
    await expect(call({ op: 'children', frame_ids: 'child-frame' })).resolves.toEqual({
      error: 'host.children frame_ids must be an array of strings.'
    })
    await expect(call({ operation: 'stop_children', frame_ids: [] })).resolves.toEqual({
      error: 'host.stop_child requires one or more frame ids.'
    })

    endInvocation()
    connection.release()
  })

  it('forwards a request array through the authenticated host seam without reordering it', async () => {
    const delegate = vi.fn(async () => ({
      kind: 'receipts' as const,
      children: [
        {
          frameId: 'frame-first',
          attemptId: 'attempt-first',
          name: 'First',
          agentName: 'Main Agent',
          status: 'running' as const
        },
        {
          frameId: 'frame-second',
          attemptId: 'attempt-second',
          name: 'Second',
          agentName: 'Main Agent',
          status: 'running' as const
        }
      ]
    }))
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate }
    })
    const connection = await server.issueControlConnection('session-1', 'project-1', 'root-frame')
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          request: [
            { task: 'First', name: 'First' },
            { task: 'Second', name: 'Second' }
          ],
          options: { wait: false }
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: {
        kind: 'receipts',
        children: [
          {
            frameId: 'frame-first',
            attemptId: 'attempt-first',
            name: 'First',
            agentName: 'Main Agent',
            status: 'running'
          },
          {
            frameId: 'frame-second',
            attemptId: 'attempt-second',
            name: 'Second',
            agentName: 'Main Agent',
            status: 'running'
          }
        ]
      }
    })
    expect(delegate).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { projectId: 'project-1', sessionId: 'session-1' },
        frameId: 'root-frame'
      }),
      [
        { task: 'First', name: 'First' },
        { task: 'Second', name: 'Second' }
      ],
      { wait: false }
    )
    endInvocation()
    connection.release()
  })

  it('canonicalizes bare same-Session immutable Version ids before delegated admission', async () => {
    const delegate = vi.fn(async () => ({ kind: 'receipts' as const, children: [] }))
    const readHostArtifactCatalog = vi.fn(
      async (request: {
        projectId: string
        versionId?: string
        finalizedArtifactsOnly?: boolean
      }): Promise<HostArtifactCatalogItem[]> => {
        expect(request).toMatchObject({
          projectId: 'project-1',
          finalizedArtifactsOnly: true
        })
        if (request.versionId === 'artifact-version-1') return [catalogItem()]
        if (request.versionId === 'upload-version-1') {
          return [
            catalogItem({
              source: 'upload',
              sourceFileId: 'upload-1',
              versionId: 'upload-version-1',
              filename: 'input.csv',
              rootFrameId: null,
              agentFrameId: null
            })
          ]
        }
        if (request.versionId === 'child-artifact-version-1') {
          return [
            catalogItem({
              sourceFileId: 'child-artifact-1',
              versionId: 'child-artifact-version-1',
              agentFrameId: 'new-child-frame'
            })
          ]
        }
        return []
      }
    )
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate },
      delegationInputCatalog: { readHostArtifactCatalog }
    })
    const connection = await server.issueControlConnection('session-1', 'project-1', 'root-frame')
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })
    const legacyArtifact = createArtifactVersionLocator({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'legacy-artifact',
      versionId: 'legacy-version'
    })
    const legacyUpload = createUploadVersionReference('legacy-upload-version', {
      projectId: 'project-1',
      sessionId: 'session-1'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          request: {
            task: 'Use exact immutable inputs',
            name: 'Exact inputs',
            inputs: [
              'artifact-version-1',
              'upload-version-1',
              'artifact-version-1',
              'child-artifact-version-1',
              legacyArtifact,
              legacyUpload
            ]
          },
          options: { wait: false }
        }
      })
    })

    expect(response.status).toBe(200)
    expect(delegate).toHaveBeenCalledWith(
      expect.any(Object),
      {
        task: 'Use exact immutable inputs',
        name: 'Exact inputs',
        inputs: [
          createArtifactVersionLocator({
            projectId: 'project-1',
            appSessionId: 'session-1',
            artifactId: 'artifact-1',
            versionId: 'artifact-version-1'
          }),
          createUploadVersionReference('upload-version-1', {
            projectId: 'project-1',
            sessionId: 'session-1'
          }),
          createArtifactVersionLocator({
            projectId: 'project-1',
            appSessionId: 'session-1',
            artifactId: 'artifact-1',
            versionId: 'artifact-version-1'
          }),
          createArtifactVersionLocator({
            projectId: 'project-1',
            appSessionId: 'session-1',
            artifactId: 'child-artifact-1',
            versionId: 'child-artifact-version-1'
          }),
          legacyArtifact,
          legacyUpload
        ]
      },
      { wait: false }
    )
    expect(readHostArtifactCatalog).toHaveBeenCalledTimes(3)
    endInvocation()
    connection.release()
  })

  it('rejects invalid request semantics before resolving bare Version ids', async () => {
    const delegate = vi.fn(async () => ({ kind: 'receipts' as const, children: [] }))
    const readHostArtifactCatalog = vi.fn(async (): Promise<HostArtifactCatalogItem[]> => [])
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate },
      delegationInputCatalog: { readHostArtifactCatalog }
    })
    const connection = await server.issueControlConnection('session-1', 'project-1', 'root-frame')
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })

    for (const request of [
      { task: '   ', name: 'Bad task', inputs: ['artifact-version-1'] },
      { task: 'Missing name', inputs: ['artifact-version-1'] },
      { task: 'Empty name', name: '   ', inputs: ['artifact-version-1'] },
      { task: 'Empty input', name: 'Bad input', inputs: [''] },
      { task: 'Wrong input shape', name: 'Bad input', inputs: 'artifact-version-1' }
    ]) {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'delegatedWorkCall',
          params: { request, options: { wait: false } }
        })
      })

      expect(response.status).toBe(500)
    }

    expect(readHostArtifactCatalog).not.toHaveBeenCalled()
    expect(delegate).not.toHaveBeenCalled()
    endInvocation()
    connection.release()
  })

  it('feeds a canonicalized bare Version id through real durable admission validation', async () => {
    const session = { projectId: 'project-1', sessionId: 'session-1' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'root-frame',
      originMessageId: 'origin-message-1'
    })
    const validated: string[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      validateInput: async (identity) => {
        validated.push(identity)
        const locator = parseArtifactVersionLocator(identity)
        return (
          locator?.projectId === session.projectId &&
          locator.appSessionId === session.sessionId &&
          locator.versionId === 'artifact-version-1'
        )
      }
    })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work,
      delegationInputCatalog: {
        readHostArtifactCatalog: async () => [catalogItem()]
      }
    })
    const connection = await server.issueControlConnection(
      session.sessionId,
      session.projectId,
      'root-frame'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          request: {
            task: 'Validate canonical input',
            name: 'Canonical input',
            inputs: ['artifact-version-1']
          },
          options: { wait: false }
        }
      })
    })

    expect(response.status).toBe(200)
    expect(validated).toEqual([
      createArtifactVersionLocator({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'artifact-version-1'
      })
    ])
    expect((await records.snapshot()).records).toHaveLength(1)
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('done')
    endInvocation()
    connection.release()
  })

  it('rejects mutable, unavailable, pending, cross-scope, and colliding bare ids before delegation', async () => {
    const delegate = vi.fn(async () => ({ kind: 'receipts' as const, children: [] }))
    const readHostArtifactCatalog = vi.fn(
      async (request: { versionId?: string }): Promise<HostArtifactCatalogItem[]> => {
        if (request.versionId === 'other-session-version') {
          return [catalogItem({ versionId: 'other-session-version', sessionId: 'session-2' })]
        }
        if (request.versionId === 'collision') {
          throw new Error(
            'Artifact Version id is ambiguous across generated Artifacts and Uploads.'
          )
        }
        return []
      }
    )
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate },
      delegationInputCatalog: { readHostArtifactCatalog }
    })
    const connection = await server.issueControlConnection('session-1', 'project-1', 'root-frame')
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })

    for (const identity of [
      'artifact-1',
      '/tmp/result.csv',
      'random-id',
      'pending-artifact-version',
      'other-project-version',
      'other-session-version',
      'collision'
    ]) {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'delegatedWorkCall',
          params: {
            request: { task: 'Must reject atomically', name: 'Reject input', inputs: [identity] },
            options: { wait: false }
          }
        })
      })
      expect(response.status).toBe(500)
      if (identity === 'artifact-1') {
        await expect(response.json()).resolves.toEqual({
          error: expect.stringMatching(/version_id\/versionId.*not artifact_id.*omit inputs/i)
        })
      }
    }

    expect(delegate).not.toHaveBeenCalled()
    endInvocation()
    connection.release()
  })

  it('rejects malformed or over-capacity arrays at the authenticated host seam', async () => {
    const delegate = vi.fn(async () => ({ kind: 'receipts' as const, children: [] }))
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate }
    })
    const connection = await server.issueControlConnection('session-1', 'project-1', 'root-frame')
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })

    const shapeError =
      'host.delegate request must be one object or a non-empty object array; pass it as the first argument.'
    for (const { request, error } of [
      { request: [], error: shapeError },
      { request: [null], error: shapeError },
      { request: ['not-an-object'], error: shapeError },
      {
        request: {
          task: 'Reject mutable input shape',
          name: 'Reject input object',
          inputs: [{ versionId: 'artifact-version-1' }]
        },
        error:
          'delegation inputs must be a string[] of exact finalized Artifact version_id/versionId or upload-version: references; do not pass objects, artifact_id, filenames, or paths; omit inputs when no file handoff is needed'
      },
      {
        request: Array.from({ length: 5 }, (_, index) => ({
          task: `Task ${index + 1}`,
          name: `Child ${index + 1}`
        })),
        error: 'host.delegate request batches must contain from 1 through 4 objects.'
      }
    ]) {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'delegatedWorkCall', params: { request } })
      })

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({ error })
    }
    expect(delegate).not.toHaveBeenCalled()
    endInvocation()
    connection.release()
  })

  it('derives delegation authority from the active control capability and ignores forged owner fields', async () => {
    const session = { projectId: 'trusted-project', sessionId: 'trusted-session' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'trusted-root-frame',
      originMessageId: 'trusted-origin-message'
    })
    const work = createDurableDelegatedWork({ execution, records })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'trusted-root-frame'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'trusted-tool-call',
      originatingUserMessageId: 'trusted-origin-message'
    })

    const responsePending = fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          project_id: 'forged-project',
          session_id: 'forged-session',
          frame_id: 'forged-frame',
          origin_message_id: 'forged-origin',
          tool_invocation_id: 'forged-tool',
          request: { task: 'Trace the source', name: 'Trace the source' }
        }
      })
    })

    await expect.poll(() => execution.controls()).toHaveLength(1)
    await expect(work.sessionSummary(session)).resolves.toMatchObject({
      runningCount: 1,
      children: [{ title: 'Trace the source', status: 'running' }]
    })
    const frameId = (await work.sessionSummary(session)).children[0].frameId
    await expect(work.readAgentFrame(session, frameId)).resolves.toMatchObject({
      status: 'running',
      messages: [{ role: 'user', content: 'Trace the source' }]
    })
    execution.controls()[0].accept()
    execution.controls()[0].complete('done')
    const response = await responsePending

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: { kind: 'results', children: [{ response: 'done' }] }
    })
    await expect(work.readAgentFrame(session, frameId)).resolves.toMatchObject({
      status: 'completed',
      messages: [
        { role: 'user', content: 'Trace the source' },
        { role: 'assistant', content: 'done' }
      ]
    })

    endInvocation()
    connection.release()
  })

  it('injects the app-owned runtime Specialist and ignores an Agent-forged parent identity', async () => {
    const delegate = vi.fn(async () => ({ kind: 'receipts' as const, children: [] }))
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate }
    })
    server.registerSessionSpecialist('trusted-session', 'trusted-specialist')
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'trusted-root-frame'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'trusted-tool-call',
      originatingUserMessageId: 'trusted-origin-message'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          request: { task: 'Inherit trusted identity', name: 'Inherit trusted identity' },
          parent_specialist_profile_id: 'forged-specialist'
        }
      })
    })

    expect(response.status).toBe(200)
    expect(delegate).toHaveBeenCalledWith(
      expect.objectContaining({ parentSpecialistId: 'trusted-specialist' }),
      { task: 'Inherit trusted identity', name: 'Inherit trusted identity' },
      {}
    )
    endInvocation()
    connection.release()
  })

  it('rejects delegation when no authenticated control invocation is active', async () => {
    const delegate = vi.fn()
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate, children: vi.fn(), collect: vi.fn() }
    })
    const connection = await server.issueControlConnection(
      'session-1',
      'project-1',
      'root-frame-session-1'
    )

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: { request: { task: 'Unauthorized', name: 'Unauthorized' } }
      })
    })

    expect(response.status).toBe(403)
    expect(delegate).not.toHaveBeenCalled()
    connection.release()
  })

  it('exposes authenticated child stop without trusting request owner fields', async () => {
    const session = { projectId: 'trusted-project', sessionId: 'trusted-session' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'trusted-root-frame',
      originMessageId: 'trusted-origin-message'
    })
    const work = createDurableDelegatedWork({ execution, records })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      session.sessionId,
      session.projectId,
      'trusted-root-frame'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'trusted-tool-call',
      originatingUserMessageId: 'trusted-origin-message'
    })
    const receipt = await work.delegate(
      {
        session,
        frameId: 'trusted-root-frame',
        role: 'main',
        originMessageId: 'trusted-origin-message',
        toolInvocationId: 'direct-admission'
      },
      { task: 'Stop through host', name: 'Stop through host' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          operation: 'stop_children',
          frame_ids: [receipt.children[0].frameId],
          project_id: 'forged-project',
          frame_id: 'forged-frame'
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: [{ frameId: receipt.children[0].frameId, status: 'cancelled' }]
    })
    endInvocation()
    connection.release()
  })

  it('fails closed before reservation and durable mutation when the framework is unavailable', async () => {
    const session = { projectId: 'project-1', sessionId: 'session-1' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'root-frame-session-1',
      originMessageId: 'origin-message-1'
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      assertAvailable: async () => {
        throw new Error('delegated execution is not certified for this framework')
      }
    })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      'session-1',
      'project-1',
      'root-frame-session-1'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: { request: { task: 'Must remain unavailable', name: 'Must remain unavailable' } }
      })
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'delegated execution is not certified for this framework'
    })
    expect(execution.reservationCounts()).toEqual([])
    expect((await records.snapshot()).records).toEqual([])
    endInvocation()
    connection.release()
  })

  it('preserves a removed own context field through RPC parsing for actionable atomic rejection', async () => {
    const session = { projectId: 'project-1', sessionId: 'session-1' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'root-frame-session-1',
      originMessageId: 'origin-message-1'
    })
    const work = createDurableDelegatedWork({ execution, records })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      'session-1',
      'project-1',
      'root-frame-session-1'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          request: [
            { task: 'valid sibling', name: 'valid sibling' },
            { task: 'legacy child', name: 'legacy child', context: 'legacy detail' }
          ]
        }
      })
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error:
        'delegate context was removed; include all goals, background, constraints, and deliverables in task and retry'
    })
    expect(execution.reservationCounts()).toEqual([])
    expect((await records.snapshot()).records).toEqual([])
    endInvocation()
    connection.release()
  })

  it('authenticates detached children and collect operations through the active control capability', async () => {
    const session = { projectId: 'trusted-project', sessionId: 'trusted-session' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'trusted-root-frame',
      originMessageId: 'trusted-origin-message'
    })
    const work = createDurableDelegatedWork({ execution, records })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'trusted-root-frame'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'trusted-tool-call',
      originatingUserMessageId: 'trusted-origin-message'
    })
    const call = async (params: Record<string, unknown>): Promise<unknown> => {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'delegatedWorkCall', params })
      })
      expect(response.status).toBe(200)
      return (await response.json()).result
    }

    const receipt = (await call({
      op: 'delegate',
      request: { task: 'Detached source check', name: 'Source check' },
      options: { wait: false }
    })) as { children: Array<{ frameId: string; attemptId: string }> }
    const frameId = receipt.children[0].frameId
    await expect(
      call({
        op: 'children',
        frame_ids: [frameId],
        project_id: 'forged-project',
        session_id: 'forged-session',
        frame_id: 'forged-parent'
      })
    ).resolves.toEqual([
      {
        frameId,
        attemptId: receipt.children[0].attemptId,
        title: 'Source check',
        name: 'Source check',
        agentName: 'Main Agent',
        status: 'running'
      }
    ])
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Durable RPC answer')

    await expect(
      call({
        op: 'collect',
        selectors: [{ frame_id: frameId, attempt_id: receipt.children[0].attemptId }],
        options: { timeout_seconds: 0 }
      })
    ).resolves.toMatchObject([
      { frameId, status: 'completed', response: 'Durable RPC answer', artifactsCreated: [] }
    ])
    endInvocation()
    connection.release()
  })

  it('routes an authenticated sendFrameMessage call to terminal-child continuation', async () => {
    const session = { projectId: 'project-1', sessionId: 'session-1' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'root-frame-session-1',
      originMessageId: 'origin-message-1'
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      {
        session,
        frameId: 'root-frame-session-1',
        role: 'main',
        originMessageId: 'origin-message-1',
        toolInvocationId: 'dispatch-call'
      },
      { task: 'Initial task', name: 'Initial task' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Initial answer')
    await expect.poll(async () => (await work.sessionSummary(session)).runningCount).toBe(0)
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      session.sessionId,
      session.projectId,
      'root-frame-session-1'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-2',
      controlInvocationGeneration: 2,
      toolInvocationId: 'continuation-call',
      originatingUserMessageId: 'origin-message-1'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          op: 'send_message',
          target: dispatched.children[0].frameId,
          message: 'Continue through the host'
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: {
        disposition: 'continued',
        target_frame_id: dispatched.children[0].frameId,
        continuation_attempt_id: expect.any(String)
      }
    })
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls()[1].input).toMatchObject({
      frameId: dispatched.children[0].frameId,
      task: 'Continue through the host',
      continuation: true
    })
    endInvocation()
    connection.release()
  })

  it('routes a Delegate question to its authenticated parent and ignores forged caller fields', async () => {
    const session = { projectId: 'project-1', sessionId: 'session-1' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'root-frame-session-1',
      originMessageId: 'origin-message-1'
    })
    const deliveries: unknown[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      deliverToParent: async (delivery) => {
        await delivery.startDispatch()
        deliveries.push(delivery)
        return 'provider_prompt_accepted'
      }
    })
    const dispatched = await work.delegate(
      {
        session,
        frameId: 'root-frame-session-1',
        role: 'main',
        originMessageId: 'origin-message-1',
        toolInvocationId: 'dispatch-call'
      },
      { task: 'Initial task', name: 'Initial task' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    const child = dispatched.children[0]
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      session.sessionId,
      session.projectId,
      child.frameId,
      { role: 'delegate', attemptId: child.attemptId }
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'child-turn',
      controlInvocationGeneration: 1,
      toolInvocationId: 'child-question',
      originatingUserMessageId: 'forged-origin-is-ignored-for-parent-routing'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          op: 'send_message',
          target: 'parent',
          message: 'Which cohort?',
          options: { kind: 'question' },
          project_id: 'forged-project',
          session_id: 'forged-session',
          frame_id: 'forged-frame',
          attempt_id: 'forged-attempt',
          caller_role: 'main'
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: { status: 'queued', direction: 'to_parent', target_frame_id: 'root-frame-session-1' }
    })
    expect(deliveries).toEqual([
      expect.objectContaining({
        sourceFrameId: child.frameId,
        sourceAttemptId: child.attemptId,
        targetFrameId: 'root-frame-session-1',
        text: 'Which cohort?',
        kind: 'question'
      })
    ])
    endInvocation()
    connection.release()
  })
})
