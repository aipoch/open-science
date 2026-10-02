import { describe, expect, it } from 'vitest'

import { projectDiagnosticLog, projectDiagnosticSession } from './projection'

describe('diagnostic log projection', () => {
  it('redacts credential-shaped codes and retains logger loss counts', () => {
    const projected = projectDiagnosticLog({
      msg: 'log records dropped',
      data: {
        code: 'AKIAABCDEFGHIJKLMNOP',
        errorCode: 'AKIAABCDEFGHIJKLMNOP',
        error: { code: 'AKIAABCDEFGHIJKLMNOP' },
        droppedRecords: 17,
        repairedTailBytes: 23
      }
    })
    expect(JSON.stringify(projected)).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(projected).toMatchObject({ diagnostics: { droppedRecords: 17, repairedTailBytes: 23 } })
  })
  it('retains new scopes and events while redacting text and excluding arbitrary payloads', () => {
    const projected = projectDiagnosticLog(
      {
        t: '2026-09-29T10:00:00.000Z',
        level: 'error',
        scope: 'new-component',
        msg: 'new failure at /Users/alice/private/project.ts',
        data: {
          operation: 'new-operation',
          phase: 'new-phase',
          sessionId: 'session-1',
          error: 'token=canary-secret at /Users/alice/private/error.ts',
          stack: 'Error: failed\n    at run (/Users/alice/private/error.ts:12:3)',
          payload: { research: 'do-not-export' },
          serviceName: 'do-not-export'
        }
      },
      { home: '/Users/alice' }
    )
    expect(projected).toMatchObject({
      scope: 'new-component',
      event: 'new failure at ~/private/project.ts',
      diagnostics: { operation: 'new-operation', phase: 'new-phase', sessionId: 'session-1' }
    })
    const serialized = JSON.stringify(projected)
    expect(serialized).toContain('error.ts:12:3')
    expect(serialized).not.toContain('canary-secret')
    expect(serialized).not.toContain('/Users/alice')
    expect(serialized).not.toContain('do-not-export')
  })

  it('retains JSON-RPC and system diagnostics through the logger error shape', () => {
    const projected = projectDiagnosticLog({
      msg: 'provider request failed',
      data: {
        error: 'Internal error',
        name: 'RequestError',
        code: -32603,
        errno: -2,
        syscall: 'spawn agent',
        data: { details: 'agent exited with code 1', payload: 'secret response body' },
        cause: { error: 'ENOENT', code: 'ENOENT', path: '/private/user/file' }
      }
    })
    expect(projected).toMatchObject({
      event: 'provider request failed',
      diagnostics: {
        error: {
          message: 'Internal error',
          name: 'RequestError',
          code: -32603,
          errno: -2,
          syscall: 'spawn agent',
          data: { details: 'agent exited with code 1' },
          cause: { message: 'ENOENT', code: 'ENOENT' }
        }
      }
    })
    expect(JSON.stringify(projected)).not.toContain('secret response body')
    expect(JSON.stringify(projected)).not.toContain('/private/user')
  })

  it('retains process termination context without an error object', () => {
    expect(
      projectDiagnosticLog({
        msg: 'child process gone',
        data: { reason: 'oom', exitCode: 9, wasUnresponsive: true, unresponsiveDurationMs: 123 }
      })
    ).toEqual({
      event: 'child process gone',
      diagnostics: {
        reason: 'oom',
        exitCode: 9,
        wasUnresponsive: true,
        unresponsiveDurationMs: 123
      }
    })
  })

  it('keeps known details containers and numeric code-only failures', () => {
    const blocked = projectDiagnosticLog({
      scope: 'database-startup',
      msg: 'database startup blocked',
      data: {
        details: {
          error: 'open failed at /Users/alice/private/database.db',
          code: 'SQLITE_CANTOPEN',
          stack: 'Error: open failed\n    at open (/Users/alice/private/db.ts:8:2)',
          payload: 'do-not-export'
        }
      }
    })
    expect(blocked).toMatchObject({
      scope: 'database-startup',
      diagnostics: { details: { code: 'SQLITE_CANTOPEN' } }
    })
    expect(JSON.stringify(blocked)).toContain('db.ts:8:2')
    expect(JSON.stringify(blocked)).not.toContain('do-not-export')
    expect(JSON.stringify(blocked)).not.toContain('/Users/alice')
    expect(projectDiagnosticLog({ msg: 'rpc failed', data: { code: -32603 } })).toEqual({
      event: 'rpc failed',
      diagnostics: { code: -32603, error: { code: -32603 } }
    })
  })

  it('does not emit arbitrary data from a record without diagnostic fields', () => {
    expect(projectDiagnosticLog({ data: { payload: 'secret', rawOutput: 'secret' } })).toEqual({})
  })
})

describe('diagnostic session projection', () => {
  it('retains failures across delegation boundaries without copying conversation payloads', () => {
    const projected = projectDiagnosticSession({
      id: 'session-1',
      runtimeContext: {
        delegatedWork: {
          records: [
            {
              agentFrameId: 'frame-1',
              attempts: [
                {
                  id: 'attempt-1',
                  error: { code: 'EIO' },
                  resolvedAgent: { displayName: 'PRIVATE' }
                }
              ]
            }
          ],
          messageCommands: [
            {
              targetAttemptId: 'attempt-1',
              text: 'PRIVATE',
              receipt: { error: { code: 'EPIPE' } }
            }
          ],
          questionRequests: [
            { questions: ['PRIVATE'], answers: ['PRIVATE'], failure: { code: 'ETIMEDOUT' } }
          ],
          recordsQuarantine: 'PRIVATE'
        }
      }
    })
    expect(projected).toHaveProperty(
      'session.runtimeContext.delegatedWork.records.0.agentFrameId',
      'frame-1'
    )
    expect(projected).toHaveProperty(
      'session.runtimeContext.delegatedWork.records.0.attempts.0.error.code',
      'EIO'
    )
    expect(projected).toHaveProperty(
      'session.runtimeContext.delegatedWork.messageCommands.0.targetAttemptId',
      'attempt-1'
    )
    expect(projected).toHaveProperty(
      'session.runtimeContext.delegatedWork.messageCommands.0.receipt.error.code',
      'EPIPE'
    )
    expect(projected).toHaveProperty(
      'session.runtimeContext.delegatedWork.questionRequests.0.failure.code',
      'ETIMEDOUT'
    )
    expect(JSON.stringify(projected)).not.toContain('PRIVATE')
  })
  it('keeps attribution and recovery links while excluding user content throughout a session', () => {
    const projected = projectDiagnosticSession({
      version: 2,
      session: {
        id: 'session-1',
        title: 'PRIVATE',
        unknownField: 'PRIVATE',
        providerContinuityToken: 'PRIVATE',
        cwd: 'PRIVATE',
        error: 'disk failed',
        resumeRecovery: { kind: 'resume-required', promptMessageId: 'msg-1' },
        messages: [
          {
            id: 'msg-1',
            content: 'PRIVATE',
            uploads: [{ path: 'PRIVATE' }],
            structuredOutputEvidence: { schema: 'PRIVATE' },
            attribution: { deliveryKey: 'delivery-1', jobIds: ['job-1'] }
          }
        ],
        activities: [
          {
            providerToolName: 'Bash',
            promptMessageId: 'msg-1',
            rawInput: 'PRIVATE',
            rawOutput: 'PRIVATE'
          }
        ],
        sessionDetailsGeneration: { status: 'failed', title: 'PRIVATE' },
        conversationGraph: {
          rootFrameId: 'frame-1',
          frames: [{ id: 'frame-1', activeBranchId: 'branch-1', agentName: 'PRIVATE' }]
        }
      }
    })
    expect(projected).toHaveProperty('session.error.message', 'disk failed')
    expect(projected).toHaveProperty('session.resumeRecovery.promptMessageId', 'msg-1')
    expect(projected).toHaveProperty('session.messages.0.attribution.deliveryKey', 'delivery-1')
    expect(projected).toHaveProperty('session.messages.0.attribution.jobIds', ['job-1'])
    expect(projected).toHaveProperty('session.activities.0.providerToolName', 'Bash')
    expect(projected).toHaveProperty('session.activities.0.promptMessageId', 'msg-1')
    expect(projected).toHaveProperty(
      'session.conversationGraph.frames.0.activeBranchId',
      'branch-1'
    )
    expect(JSON.stringify(projected)).not.toContain('PRIVATE')
  })
})

it('retains bounded runtime failure context and omits private or unknown diagnostic values', () => {
  expect(
    projectDiagnosticLog({
      msg: 'Runtime Session authority unavailable',
      data: {
        operation: 'runtime-session-mutation',
        phase: 'load-authority',
        authorityStatus: 'unreadable',
        projectId: 'project-1',
        sessionId: 'session-1',
        cachedProjectId: 'project-2',
        metadataComplete: true,
        text: 'PRIVATE_PROMPT',
        error: { stack: 'PRIVATE_STACK' }
      }
    })
  ).toEqual({
    event: 'Runtime Session authority unavailable',
    diagnostics: {
      operation: 'runtime-session-mutation',
      phase: 'load-authority',
      authorityStatus: 'unreadable',
      projectId: 'project-1',
      sessionId: 'session-1',
      cachedProjectId: 'project-2',
      metadataComplete: true,
      error: { stack: 'PRIVATE_STACK' }
    }
  })
  expect(
    projectDiagnosticLog({
      data: {
        authorityStatus: 'PRIVATE_STATUS',
        cachedProjectId: '/PRIVATE_PATH',
        metadataComplete: 'PRIVATE_BOOL'
      }
    })
  ).toEqual({})
})

it('preserves permission trace classifications and rejects spoofed raw identity fields', () => {
  expect(
    projectDiagnosticLog({
      scope: 'permission',
      msg: 'permission decision trace',
      data: {
        stage: 'decision',
        profile: 'ask',
        modelRoute: 'codex-bridge',
        authority: 'registry_grant',
        identitySource: 'verified_context',
        matchedScope: 'session',
        fallback: false,
        toolKind: 'execute',
        hasReportedToolName: false,
        hasRawInput: true,
        hasLocations: false,
        capabilityKind: 'skill_operation',
        capabilityKey: 'skill:invoke',
        sessionRef: '0123456789abcdef',
        toolCallRef: '/private/untrusted/tool',
        requestRef: 'raw-provider-id',
        reportedToolRef: 'raw-custom-tool',
        rawInput: 'private-input'
      }
    })
  ).toMatchObject({
    diagnostics: {
      stage: 'decision',
      profile: 'ask',
      modelRoute: 'codex-bridge',
      authority: 'registry_grant',
      identitySource: 'verified_context',
      matchedScope: 'session',
      fallback: false,
      toolKind: 'execute',
      hasReportedToolName: false,
      hasRawInput: true,
      hasLocations: false,
      capabilityKind: 'skill_operation',
      capabilityKey: 'skill:invoke',
      sessionRef: '0123456789abcdef'
    }
  })
  const invalid = projectDiagnosticLog({
    scope: 'permission',
    msg: 'permission decision trace',
    data: {
      authority: 'private-authority',
      modelRoute: 'private-route',
      stage: 'private-stage',
      toolKind: 'private-kind',
      hasRawInput: 'private-input',
      capabilityKey: 'mcp:private-secret/tool',
      toolCallRef: 'private-tool',
      rawInput: 'private-input'
    }
  })
  expect(JSON.stringify(invalid)).not.toContain('private-')
})
