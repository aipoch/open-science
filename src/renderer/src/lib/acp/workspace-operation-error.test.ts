import { CLAUDE_CLI_INCOMPATIBLE_MESSAGE } from '../../../../shared/claude-runtime'
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
    failures: {},
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

it.each([
  'Retry to stop the previous execution and reconnect.',
  '重试以停止之前的执行并重新连接。',
  'Réessayez pour arrêter l’exécution précédente et vous reconnecter.'
])(
  'classifies resume failure from its original exception independently of display locale: %s',
  (displayMessage) => {
    const rawError = new Error('The previous execution is still using this conversation.')
    reportWorkspaceOperationError('session', displayMessage, { operation: 'resume', rawError })
    expect(useWorkspaceOperationErrors.getState().failures.session).toMatchObject({
      category: 'session',
      reason: 'session/previous-execution-active'
    })
    expect(useWorkspaceOperationErrors.getState().errors.session).toBe(displayMessage)
    expect(useWorkspaceOperationErrors.getState().diagnostics.session.detail).toBe(rawError.stack)
    clearWorkspaceOperationError('session')
    expect(useWorkspaceOperationErrors.getState().failures.session).toBeUndefined()
  }
)

it('keeps an unrelated operation timeout outside session recovery', () => {
  reportWorkspaceOperationError('session', 'The upload timed out.')
  expect(useWorkspaceOperationErrors.getState().failures.session.category).not.toBe('session')
})

it('classifies exact runtime guidance from the exception message while retaining its stack for disclosure', () => {
  const rawError = new Error(CLAUDE_CLI_INCOMPATIBLE_MESSAGE)
  reportWorkspaceOperationError('session', '请更新智能体运行时。', {
    operation: 'resume',
    rawError
  })
  expect(useWorkspaceOperationErrors.getState().failures.session.reason).toBe(
    'configuration/claude-cli'
  )
  expect(useWorkspaceOperationErrors.getState().diagnostics.session.detail).toBe(rawError.stack)
})
