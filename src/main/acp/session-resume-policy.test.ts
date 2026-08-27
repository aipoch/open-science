import { describe, expect, it } from 'vitest'

import { AcpSessionResumePolicy } from './session-resume-policy'

describe('ACP Session resume policy', () => {
  it('resumes a compatible provider Session without replacing the stable App Session identity', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.decide({
        appSessionId: 'stable-app-session',
        providerSessionId: 'provider-session-42',
        previousFrameworkId: 'opencode',
        currentFrameworkId: 'opencode',
        previousBackendId: 'opencode:provider-a',
        currentBackendId: 'opencode:provider-a',
        resumeCapabilityAdvertised: true
      })
    ).toEqual({
      action: 'resume',
      reason: 'compatible',
      appSessionId: 'stable-app-session',
      providerSessionId: 'provider-session-42',
      contextReset: false
    })
  })

  it.each([
    {
      name: 'framework',
      previousFrameworkId: 'claude-code' as const,
      currentFrameworkId: 'opencode' as const,
      previousBackendId: 'shared-backend',
      currentBackendId: 'shared-backend',
      reason: 'framework-changed'
    },
    {
      name: 'backend',
      previousFrameworkId: 'codex' as const,
      currentFrameworkId: 'codex' as const,
      previousBackendId: 'codex:shared',
      currentBackendId: 'codex:isolated',
      reason: 'backend-changed'
    }
  ])('adopts under the stable App Session ID when the $name affinity changes', (affinity) => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.decide({
        appSessionId: 'stable-app-session',
        providerSessionId: 'old-provider-session',
        ...affinity,
        resumeCapabilityAdvertised: false
      })
    ).toEqual({
      action: 'adopt',
      reason: affinity.reason,
      appSessionId: 'stable-app-session',
      providerSessionId: 'old-provider-session',
      contextReset: true
    })
  })

  it('adopts a fresh Codex Session when the provider Session ID is not a UUID', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.decide({
        appSessionId: '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
        providerSessionId: 'ses_0458258b7ffeH2DeqPYBPk6fh2',
        previousFrameworkId: 'codex',
        currentFrameworkId: 'codex',
        resumeCapabilityAdvertised: true
      })
    ).toEqual({
      action: 'adopt',
      reason: 'codex-provider-session-id-incompatible',
      appSessionId: '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
      providerSessionId: 'ses_0458258b7ffeH2DeqPYBPk6fh2',
      contextReset: true
    })
  })

  it.each([
    '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
    'urn:uuid:019fb8c8-6c66-7f22-9653-17b5b287dbbb'
  ])(
    'resumes the valid Codex provider Session ID %s under a stable App alias',
    (providerSessionId) => {
      const policy = new AcpSessionResumePolicy()

      expect(
        policy.decide({
          appSessionId: 'stable-app-session',
          providerSessionId,
          previousFrameworkId: 'codex',
          currentFrameworkId: 'codex',
          resumeCapabilityAdvertised: true
        })
      ).toEqual({
        action: 'resume',
        reason: 'compatible',
        appSessionId: 'stable-app-session',
        providerSessionId,
        contextReset: false
      })
    }
  )

  it('adopts instead of sending a legacy OpenCode Session ID to Claude', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.decide({
        appSessionId: 'stable-app-session',
        providerSessionId: 'ses_03fed93d1ffe1uw7XFraUNPhun',
        currentFrameworkId: 'claude-code',
        resumeCapabilityAdvertised: true
      })
    ).toEqual({
      action: 'adopt',
      reason: 'opencode-provider-session-id-incompatible-with-claude',
      appSessionId: 'stable-app-session',
      providerSessionId: 'ses_03fed93d1ffe1uw7XFraUNPhun',
      contextReset: true
    })
  })

  it.each([
    { previous: undefined, current: 'bridge-current' },
    { previous: 'bridge-old', current: 'bridge-current' },
    { previous: 'bridge-old', current: undefined }
  ])(
    'fresh-adopts Codex Bridge when hidden reasoning continuity is unavailable',
    ({ previous, current }) => {
      const policy = new AcpSessionResumePolicy()

      expect(
        policy.decide({
          appSessionId: 'stable-app-session',
          providerSessionId: '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
          previousFrameworkId: 'codex',
          currentFrameworkId: 'codex',
          currentModelRoute: 'codex-bridge',
          previousProviderContinuityToken: previous,
          currentProviderContinuityToken: current,
          resumeCapabilityAdvertised: true
        })
      ).toMatchObject({
        action: 'adopt',
        reason: 'provider-continuity-lost',
        contextReset: true
      })
    }
  )

  it('resumes Codex Bridge while its hidden reasoning cache is continuous', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.decide({
        appSessionId: 'stable-app-session',
        providerSessionId: '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
        previousFrameworkId: 'codex',
        currentFrameworkId: 'codex',
        currentModelRoute: 'codex-bridge',
        previousProviderContinuityToken: 'bridge-current',
        currentProviderContinuityToken: 'bridge-current',
        resumeCapabilityAdvertised: true
      })
    ).toMatchObject({ action: 'resume', reason: 'compatible', contextReset: false })
  })

  it('fresh-adopts when the Agent did not advertise resume support', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.decide({
        appSessionId: 'stable-app-session',
        currentFrameworkId: 'opencode',
        previousFrameworkId: 'opencode',
        previousBackendId: 'opencode:provider-a',
        currentBackendId: 'opencode:provider-a',
        resumeCapabilityAdvertised: false
      })
    ).toEqual({
      action: 'adopt',
      reason: 'resume-capability-not-advertised',
      appSessionId: 'stable-app-session',
      providerSessionId: 'stable-app-session',
      contextReset: true
    })
  })

  it('classifies the ACP resource-not-found response as adoptable', () => {
    const policy = new AcpSessionResumePolicy()

    expect(policy.classifyFailure({ code: -32002, message: 'Resource not found' })).toEqual({
      disposition: 'adoptable',
      reason: 'resource-not-found-code'
    })
  })

  it('classifies a legacy session-not-found message as adoptable', () => {
    const policy = new AcpSessionResumePolicy()

    expect(policy.classifyFailure({ code: -32603, message: 'Session not found' })).toEqual({
      disposition: 'adoptable',
      reason: 'session-not-found-message'
    })
  })

  it('classifies Codex missing-rollout resume failures as adoptable', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.classifyFailure({
        code: -32603,
        message: 'no rollout found for thread id 019fb8c8-6c66-7f22-9653-17b5b287dbbb'
      })
    ).toEqual({
      disposition: 'adoptable',
      reason: 'session-not-found-message'
    })
  })

  it.each(['codex-responses', 'codex-responses-compatibility'] as const)(
    'classifies a legacy %s Unknown error as adoptable',
    (currentModelRoute) => {
      const policy = new AcpSessionResumePolicy()

      expect(
        policy.classifyFailure(
          { code: -32603, message: 'Unknown error' },
          {
            currentFrameworkId: 'codex',
            currentModelRoute,
            providerSessionIdPersisted: false
          }
        )
      ).toEqual({
        disposition: 'adoptable',
        reason: 'legacy-codex-session-unavailable'
      })
    }
  )
  it.each(['opencode-anthropic', 'opencode-openai'] as const)(
    'classifies a legacy %s Unknown error as adoptable',
    (currentModelRoute) => {
      const policy = new AcpSessionResumePolicy()

      expect(
        policy.classifyFailure(
          { code: -32603, message: 'Unknown error' },
          {
            currentFrameworkId: 'opencode',
            currentModelRoute,
            providerSessionIdPersisted: false
          }
        )
      ).toEqual({
        disposition: 'adoptable',
        reason: 'legacy-opencode-session-unavailable'
      })
    }
  )

  it.each([
    [
      'non-internal Codex',
      { code: -32001, message: 'Unknown error' },
      {
        currentFrameworkId: 'codex',
        currentModelRoute: 'codex-responses',
        providerSessionIdPersisted: false
      },
      'non-internal-error'
    ],
    [
      'missing-code OpenCode',
      { message: 'Unknown error' },
      {
        currentFrameworkId: 'opencode',
        currentModelRoute: 'opencode-openai',
        providerSessionIdPersisted: false
      },
      'non-internal-error'
    ],
    [
      'non-session OpenCode service',
      { code: -32603, message: 'Unknown error', data: { service: 'transport' } },
      {
        currentFrameworkId: 'opencode',
        currentModelRoute: 'opencode-anthropic',
        providerSessionIdPersisted: false
      },
      'non-session-service-failure'
    ]
  ] as const)('keeps a %s Unknown error authoritative', (_label, error, context, reason) => {
    const policy = new AcpSessionResumePolicy()

    expect(policy.classifyFailure(error, context)).toEqual({
      disposition: 'authoritative',
      reason
    })
  })

  it.each([
    ['Claude Code', 'claude-code', undefined],
    ['Codex Bridge', 'codex', 'codex-bridge']
  ] as const)(
    'keeps an Unknown error authoritative for legacy %s Sessions',
    (_label, currentFrameworkId, currentModelRoute) => {
      const policy = new AcpSessionResumePolicy()

      expect(
        policy.classifyFailure(
          { code: -32603, message: 'Unknown error' },
          { currentFrameworkId, currentModelRoute, providerSessionIdPersisted: false }
        )
      ).toEqual({
        disposition: 'authoritative',
        reason: 'non-internal-error'
      })
    }
  )

  it.each(['codex-responses', 'codex-responses-compatibility'] as const)(
    'classifies a persisted %s Unknown error as adoptable',
    (currentModelRoute) => {
      const policy = new AcpSessionResumePolicy()

      expect(
        policy.classifyFailure(
          { code: -32603, message: 'Unknown error' },
          {
            currentFrameworkId: 'codex',
            currentModelRoute,
            providerSessionIdPersisted: true
          }
        )
      ).toEqual({
        disposition: 'adoptable',
        reason: 'legacy-codex-session-unavailable'
      })
    }
  )

  it('keeps an Unknown error authoritative for a persisted OpenCode identity', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.classifyFailure(
        { code: -32603, message: 'Unknown error' },
        {
          currentFrameworkId: 'opencode',
          currentModelRoute: 'opencode-openai',
          providerSessionIdPersisted: true
        }
      )
    ).toEqual({
      disposition: 'authoritative',
      reason: 'non-internal-error'
    })
  })

  it('treats the provider session-service marker as an adoptable failure', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.classifyFailure({
        code: -32603,
        message: 'OpenCode service failure',
        data: { service: 'session' }
      })
    ).toEqual({
      disposition: 'adoptable',
      reason: 'session-service-failure'
    })
  })

  it.each([
    'session-not-found',
    'conversation_not_found',
    'Session Missing',
    'conversation-missing',
    'session_resume_failed',
    'conversation restore failed'
  ])('recognizes the structured unresumable error kind %s', (errorKind) => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.classifyFailure({
        code: -32603,
        message: 'Internal error',
        data: { errorKind, details: 'localized diagnostic' }
      })
    ).toEqual({
      disposition: 'adoptable',
      reason: 'unresumable-error-kind'
    })
  })

  it('keeps an unknown structured reason authoritative even when its detail looks adoptable', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.classifyFailure({
        code: -32603,
        message: 'Internal error',
        data: {
          errorKind: 'provider-error',
          details: 'Failed to restore the previous conversation'
        }
      })
    ).toEqual({
      disposition: 'authoritative',
      reason: 'unknown-error-kind'
    })
  })

  it.each([
    'Failed to restore the previous conversation',
    'The session identifier was not found',
    'No saved session is available'
  ])('recognizes a narrow legacy unresumable detail: %s', (details) => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.classifyFailure({
        code: -32603,
        message: 'Internal error',
        data: { details }
      })
    ).toEqual({
      disposition: 'adoptable',
      reason: 'legacy-unresumable-details'
    })
  })

  it('keeps an explicit non-session service failure authoritative', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.classifyFailure({
        code: -32603,
        message: 'Internal error',
        data: { service: 'provider' }
      })
    ).toEqual({
      disposition: 'authoritative',
      reason: 'non-session-service-failure'
    })
  })

  it('does not let diagnostic text override a structured non-session service failure', () => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.classifyFailure({
        code: -32603,
        message: 'Provider diagnostic quoted “Session not found” while loading credentials',
        data: { service: 'provider' }
      })
    ).toEqual({
      disposition: 'authoritative',
      reason: 'non-session-service-failure'
    })
  })

  it('keeps an opaque detail-free Internal error authoritative', () => {
    const policy = new AcpSessionResumePolicy()

    expect(policy.classifyFailure({ code: -32603, message: 'Internal error' })).toEqual({
      disposition: 'authoritative',
      reason: 'unrelated-internal-error'
    })
  })

  it.each([
    'Authentication failed while configuring the provider',
    'Failed to load session provider credentials',
    'Unable to load Model Context Protocol server for this session',
    'Unknown model context for this conversation'
  ])('keeps an unrelated Internal error authoritative: %s', (details) => {
    const policy = new AcpSessionResumePolicy()

    expect(
      policy.classifyFailure({ code: -32603, message: 'Internal error', data: { details } })
    ).toEqual({
      disposition: 'authoritative',
      reason: 'unrelated-internal-error'
    })
  })

  it.each([
    { code: -32602, message: 'Invalid params' },
    { code: -32603, message: 'Internal error: provider blew up' }
  ])('keeps the non-resumable provider error $code / $message authoritative', (failure) => {
    const policy = new AcpSessionResumePolicy()

    expect(policy.classifyFailure(failure)).toEqual({
      disposition: 'authoritative',
      reason: 'non-internal-error'
    })
  })

  it('classifies hostile error objects without invoking their traps beyond recovery', () => {
    const policy = new AcpSessionResumePolicy()
    const hostileMessage = Object.defineProperty({ code: -32603 }, 'message', {
      get: () => {
        throw new Error('message getter trap')
      }
    })
    const hostileError = new Proxy(
      {},
      {
        get: () => {
          throw new Error('error proxy trap')
        }
      }
    )
    const hostileData = {
      code: -32603,
      message: 'Internal error',
      data: new Proxy(
        {},
        {
          get: () => {
            throw new Error('data proxy trap')
          }
        }
      )
    }

    for (const failure of [hostileMessage, hostileError, hostileData]) {
      expect(policy.classifyFailure(failure)).toEqual({
        disposition: 'authoritative',
        reason: 'uninspectable-error'
      })
    }
  })
})
