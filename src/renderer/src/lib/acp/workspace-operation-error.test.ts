import { useSettingsStore } from '@/stores/settings-store'
import { beforeEach, expect, it } from 'vitest'
import {
  clearWorkspaceOperationError,
  reportWorkspaceOperationError,
  useWorkspaceOperationErrors
} from './workspace-operation-error'

beforeEach(() =>
  useWorkspaceOperationErrors.setState({
    errors: {},
    providerValidations: {},
    providerTargets: {},
    diagnostics: {}
  })
)
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

it('retains the initiating provider until the error is replaced or cleared', () => {
  reportWorkspaceOperationError('first', 'Authentication required', {
    providerTarget: { providerId: 'provider-b', model: 'target-model' }
  })
  reportWorkspaceOperationError('second', 'Authentication required', {
    providerTarget: { providerId: 'provider-a' }
  })
  expect(useWorkspaceOperationErrors.getState().providerTargets).toEqual({
    first: { providerId: 'provider-b', model: 'target-model' },
    second: { providerId: 'provider-a' }
  })
  reportWorkspaceOperationError('first', 'Another failure')
  expect(useWorkspaceOperationErrors.getState().providerTargets.first).toBeUndefined()
  clearWorkspaceOperationError('second')
  expect(useWorkspaceOperationErrors.getState().providerTargets).not.toHaveProperty('second')
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

it('captures shared validation baselines when errors occur and clears only the initiating session', () => {
  const provider = useSettingsStore.getState().providers[0]
  useSettingsStore.setState({ providers: [{ ...provider, id: 'provider', lastValidatedAt: 10 }] })
  reportWorkspaceOperationError('first', 'Authentication required')
  reportWorkspaceOperationError('second', 'Authentication required')
  useSettingsStore.setState({ providers: [{ ...provider, id: 'provider', lastValidatedAt: 30 }] })
  reportWorkspaceOperationError('first', 'Authentication required')
  expect(useWorkspaceOperationErrors.getState().providerValidations).toEqual({
    first: { provider: 30 },
    second: { provider: 10 }
  })
  clearWorkspaceOperationError('first')
  expect(useWorkspaceOperationErrors.getState().providerValidations).toEqual({
    second: { provider: 10 }
  })
})
