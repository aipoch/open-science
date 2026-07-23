import { describe, expect, it } from 'vitest'

import { describePromptError } from '../main/acp/prompt-error'
import {
  IMAGE_REPLAY_UNSUPPORTED_MESSAGE,
  PROVIDER_RESOURCE_NOT_FOUND_PREFIX,
  RESUME_MODEL_INCOMPATIBLE_MESSAGE,
  RESUME_RECONNECT_FAILED_MESSAGE,
  RESUME_TIMED_OUT_MESSAGE,
  RESUME_UNSUPPORTED_MESSAGE,
  RESUME_WORKSPACE_MISSING_MESSAGE,
  isExpectedRunFailure,
  isReportableRunFailure
} from './run-error-classification'

describe('isReportableRunFailure', () => {
  it('reports an empty or whitespace-only failure (nothing explains it)', () => {
    expect(isReportableRunFailure(undefined)).toBe(true)
    expect(isReportableRunFailure(null)).toBe(true)
    expect(isReportableRunFailure('')).toBe(true)
    expect(isReportableRunFailure('   ')).toBe(true)
  })

  it('reports an opaque / internal failure', () => {
    expect(isReportableRunFailure('Agent session could not be created.')).toBe(true)
    expect(isReportableRunFailure('Agent session did not return a workspace.')).toBe(true)
    expect(isReportableRunFailure('Permission response failed')).toBe(true)
    expect(isReportableRunFailure('Run failed: connection reset')).toBe(true)
    // An unrecognized resume cause keeps the generic fallback and stays reportable.
    expect(isReportableRunFailure('Agent session resume failed: something odd')).toBe(true)
  })

  it('does not report an app-crafted, actionable failure', () => {
    for (const message of [
      RESUME_WORKSPACE_MISSING_MESSAGE,
      RESUME_TIMED_OUT_MESSAGE,
      RESUME_UNSUPPORTED_MESSAGE,
      RESUME_RECONNECT_FAILED_MESSAGE,
      RESUME_MODEL_INCOMPATIBLE_MESSAGE,
      IMAGE_REPLAY_UNSUPPORTED_MESSAGE
    ]) {
      expect(isReportableRunFailure(message)).toBe(false)
    }
  })

  it('does not report a recognized provider-side error', () => {
    // Auth
    expect(isExpectedRunFailure('HTTP 401 Unauthorized')).toBe(true)
    expect(isExpectedRunFailure('{"error":{"type":"authentication_error"}}')).toBe(true)
    expect(isExpectedRunFailure('invalid_api_key: check your key')).toBe(true)
    expect(isExpectedRunFailure('403 permission_denied')).toBe(true)
    // Rate limit
    expect(isExpectedRunFailure('429 Too Many Requests')).toBe(true)
    expect(isExpectedRunFailure('rate_limit_error: slow down')).toBe(true)
    // Quota / billing
    expect(isExpectedRunFailure('insufficient_quota')).toBe(true)
    expect(isExpectedRunFailure('Your billing plan has no remaining credit')).toBe(true)
    // Overloaded / unavailable
    expect(isExpectedRunFailure('overloaded_error')).toBe(true)
    expect(isExpectedRunFailure('503 Service Unavailable')).toBe(true)
  })

  it('recognizes a request-size overflow (its own recovery path) as expected', () => {
    expect(isExpectedRunFailure('Request too large (max 32MB)')).toBe(true)
    expect(isExpectedRunFailure('maximum context length exceeded')).toBe(true)
  })

  it('recognizes the provider resource-not-found message built by describePromptError', () => {
    // Drift guard: feed describePromptError's REAL output through the classifier so the shared prefix
    // constant and the produced message can never diverge silently.
    const error = Object.assign(
      new Error(
        'Internal error: Not Found: {"error":{"message":"model xyz not found","type":"resource_not_found"}}'
      ),
      { code: -32603, data: { errorName: 'APIError' }, name: 'RequestError' }
    )
    const produced = describePromptError(error, { model: 'xyz' })
    expect(produced.startsWith(PROVIDER_RESOURCE_NOT_FOUND_PREFIX)).toBe(true)
    expect(isReportableRunFailure(produced)).toBe(false)
  })

  it('does not misclassify an ordinary failure that lacks any recognized signal', () => {
    expect(isExpectedRunFailure('TypeError: cannot read property foo of undefined')).toBe(false)
    expect(isExpectedRunFailure('Unexpected token < in JSON at position 0')).toBe(false)
  })
})
