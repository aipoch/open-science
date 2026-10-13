import { beforeEach, expect, it } from 'vitest'
import {
  clearWorkspaceOperationError,
  reportWorkspaceOperationError,
  useWorkspaceOperationErrors
} from './workspace-operation-error'

beforeEach(() => useWorkspaceOperationErrors.setState({ errors: {}, diagnostics: {} }))
it('keeps the captured exception separate from normalized text and scoped to its initiating session', () => {
  const error = new Error('Error invoking remote method: Internal error')
  reportWorkspaceOperationError('first', 'Unknown error', { operation: 'resume', rawError: error })
  reportWorkspaceOperationError('second', 'Another error')
  expect(useWorkspaceOperationErrors.getState().errors.first).toBe('Unknown error')
  expect(useWorkspaceOperationErrors.getState().diagnostics.first.detail).toBe(error.stack)
  expect(useWorkspaceOperationErrors.getState().diagnostics.second).toBeUndefined()
  clearWorkspaceOperationError('second')
  expect(useWorkspaceOperationErrors.getState().diagnostics.first.detail).toBe(error.stack)
  clearWorkspaceOperationError('first')
  expect(useWorkspaceOperationErrors.getState().diagnostics).toEqual({})
})
it('removes stale resume details when another operation replaces the error', () => {
  reportWorkspaceOperationError('session', 'Unknown error', {
    operation: 'resume',
    rawError: 'raw'
  })
  reportWorkspaceOperationError('session', 'Cannot send')
  expect(useWorkspaceOperationErrors.getState().diagnostics.session).toBeUndefined()
})

it('retains structured thrown exception fields before normalizing its message', () => {
  const raw = {
    message: 'Internal error',
    code: -32603,
    data: { errorKind: 'session_resume_failed', service: 'provider' }
  }
  reportWorkspaceOperationError('session', 'Unknown error', { operation: 'resume', rawError: raw })
  expect(JSON.parse(useWorkspaceOperationErrors.getState().diagnostics.session.detail)).toEqual(raw)
})
