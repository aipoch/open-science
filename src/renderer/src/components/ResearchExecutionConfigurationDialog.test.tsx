// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18nTestStub } from '../../../../test/i18n-test-stub'
import type {
  ResearchExecutionConfigurationSnapshot,
  ResearchExecutionProfileView
} from '../../../shared/research-execution-profile'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
import {
  ResearchExecutionConfigurationDialog,
  ResearchExecutionConfigurationForm
} from './ResearchExecutionConfigurationDialog'

vi.mock('react-i18next', () => createI18nTestStub())
const api = { pending: vi.fn(), inspect: vi.fn(), save: vi.fn(), remove: vi.fn(), resolve: vi.fn() }
const binding = {
  projectId: 'requested-project',
  sourceSessionId: 'source',
  sourceIdentity: 'pinned-source',
  descriptorVersionId: 'descriptor',
  descriptorSha256: 'a'.repeat(64),
  planKey: 'scientific'
}
const request: ResearchExecutionConfigurationSnapshot = {
  configurationId: 'configuration-id',
  requestId: 'request-id',
  status: 'pending',
  createdAt: 1,
  expiresAt: Date.now() + 600000,
  scope: {
    projectId: binding.projectId,
    sourceSessionId: binding.sourceSessionId,
    sourceIdentity: binding.sourceIdentity,
    descriptorVersionId: binding.descriptorVersionId,
    planKey: binding.planKey,
    sessionId: 'requesting-discussion'
  },
  preflight: {
    status: 'blocked',
    binding,
    sourceTitle: 'Requested research',
    planTitle: 'Original LLM experiment',
    profiles: [],
    issues: [{ code: 'credential-required', key: 'provider-key' }],
    compatibleRuntimeIds: ['runtime'],
    remoteServicesVerified: false,
    slots: [
      {
        key: 'provider-key',
        description: 'Provider key',
        environmentVariable: 'PROVIDER_API_KEY',
        required: true,
        status: 'missing'
      }
    ]
  }
}
const profile: ResearchExecutionProfileView = {
  profileId: 'profile',
  binding,
  displayName: 'Local provider',
  variables: { MODEL_NAME: 'real-model' },
  configuredCredentialKeys: ['provider-key'],
  allowedNetworkHosts: ['api.example.com'],
  conditionChanges: ['Recipient account'],
  updatedAt: 2
}
beforeEach(() => {
  vi.clearAllMocks()
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
  api.pending.mockResolvedValue([request])
  api.inspect.mockResolvedValue(request.preflight)
  api.save.mockResolvedValue(profile)
  api.resolve.mockResolvedValue({ ...request, status: 'configured', profileId: 'profile' })
  api.remove.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { researchExecutionProfiles: api }
  })
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
})

it('opens a global request with the broker source even without a workspace Session', async () => {
  render(<ResearchExecutionConfigurationDialog />)
  expect(await screen.findByRole('dialog', { name: 'Configure research execution' })).toBeTruthy()
  expect(screen.getByText('Requested research')).toBeTruthy()
  expect(screen.getByText('Original LLM experiment')).toBeTruthy()
  expect(
    screen.getByText('A required credential has not been configured. (provider-key)')
  ).toBeTruthy()
  expect(api.save).not.toHaveBeenCalled()
})

it('sends private input only to the trusted save IPC and resolves only with a profile ID', async () => {
  const resolved = vi.fn()
  render(<ResearchExecutionConfigurationForm request={request} onResolved={resolved} />)
  fireEvent.change(screen.getByLabelText('Configuration name'), {
    target: { value: 'My environment' }
  })
  const password = screen.getByLabelText(/Provider key/)
  expect(password.getAttribute('type')).toBe('password')
  fireEvent.change(password, { target: { value: 'private-test-value' } })
  fireEvent.change(screen.getByLabelText(/Allowed service hostnames/), {
    target: { value: 'api.example.com' }
  })
  fireEvent.change(screen.getByLabelText(/Changes from the original experiment/), {
    target: { value: 'Recipient model account' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  await waitFor(() => expect(resolved).toHaveBeenCalledOnce())
  expect(api.save).toHaveBeenCalledWith({
    ...request.scope,
    ...binding,
    profileId: undefined,
    displayName: 'My environment',
    credentials: { 'provider-key': 'private-test-value' },
    variables: {},
    allowedNetworkHosts: ['api.example.com'],
    conditionChanges: ['Recipient model account']
  })
  expect(api.resolve).toHaveBeenCalledWith({
    configurationId: request.configurationId,
    outcome: 'configured',
    profileId: 'profile'
  })
  expect((password as HTMLInputElement).value).toBe('')
  expect(JSON.stringify(api.resolve.mock.calls)).not.toContain('private-test-value')
})

it('never fills existing credential values and an empty field preserves the configured slot', async () => {
  const configured = {
    ...request,
    preflight: { ...request.preflight, selectedProfileId: profile.profileId, profiles: [profile] }
  }
  render(<ResearchExecutionConfigurationForm request={configured} onResolved={vi.fn()} />)
  const password = screen.getByPlaceholderText('Already configured') as HTMLInputElement
  expect(password.value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  await waitFor(() => expect(api.resolve).toHaveBeenCalled())
  expect(api.save.mock.calls[0][0].credentials).toEqual({})
  expect(api.save.mock.calls[0][0].profileId).toBe('profile')
})

it('dismisses without saving credentials or authorizing any execution', async () => {
  const resolved = vi.fn()
  render(<ResearchExecutionConfigurationForm request={request} onResolved={resolved} />)
  fireEvent.change(screen.getByLabelText(/Provider key/), { target: { value: 'unsaved-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  await waitFor(() => expect(resolved).toHaveBeenCalledOnce())
  expect(api.resolve).toHaveBeenCalledWith({
    configurationId: request.configurationId,
    outcome: 'dismissed'
  })
  expect(api.save).not.toHaveBeenCalled()
  expect(JSON.stringify(api.resolve.mock.calls)).not.toContain('unsaved-secret')
})

it('blocks wildcard or URL service grants and runtime-control environment variables', async () => {
  render(<ResearchExecutionConfigurationForm request={request} onResolved={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Configuration name'), { target: { value: 'Profile' } })
  fireEvent.change(screen.getByLabelText(/Allowed service hostnames/), {
    target: { value: 'https://*.example.com/path' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add environment variable' }))
  fireEvent.change(screen.getByLabelText('Variable name'), { target: { value: 'NODE_OPTIONS' } })
  expect(screen.getByRole('button', { name: 'Save configuration' }).hasAttribute('disabled')).toBe(
    true
  )
  expect(api.save).not.toHaveBeenCalled()
})

it('clears secrets after save even if resolving the broker request fails', async () => {
  api.resolve.mockRejectedValueOnce(new Error('expired'))
  render(<ResearchExecutionConfigurationForm request={request} onResolved={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Configuration name'), { target: { value: 'Profile' } })
  fireEvent.change(screen.getByLabelText(/Provider key/), {
    target: { value: 'private-test-value' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  await screen.findByText(
    'Could not update this local configuration. Your experiment has not been started.'
  )
  expect((screen.getByLabelText(/Provider key/) as HTMLInputElement).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2))
  expect(api.save.mock.calls[1][0].profileId).toBe('profile')
  expect(api.save.mock.calls[1][0].credentials).toEqual({})
})

it('deletes only the selected local profile and does not settle or run the experiment', async () => {
  render(
    <ResearchExecutionConfigurationForm
      request={{
        ...request,
        preflight: { ...request.preflight, profiles: [profile], selectedProfileId: 'profile' }
      }}
      onResolved={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Delete local configuration' }))
  await waitFor(() =>
    expect(api.remove).toHaveBeenCalledWith({ ...request.scope, profileId: 'profile' })
  )
  expect(api.resolve).not.toHaveBeenCalled()
  expect(api.save).not.toHaveBeenCalled()
})

it('does not request native private configuration from the browser surface', async () => {
  document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
  render(<ResearchExecutionConfigurationDialog />)
  await act(async () => {})
  expect(api.pending).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})
