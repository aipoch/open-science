// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import { ModelPanel } from './ModelPanel'
import type { ModelView } from './ModelPanel'
import type {
  ClassificationSnapshot,
  ClassificationMutationResult
} from '../../../../shared/classification'
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined
let state: ClassificationSnapshot
const api = {
  getClassification: vi.fn(async () => state),
  updateClassification: vi.fn(async (request): Promise<ClassificationMutationResult> => {
    state = { ...state, revision: state.revision + 1 }
    if (request.kind === 'save')
      state.services = [
        {
          id: request.id,
          adapter: request.adapter,
          providerId: request.providerId,
          name: request.name,
          configured: true,
          maskedKey: '••••-key'
        }
      ]
    if (request.kind === 'bind') {
      state.capabilitySelection = request.binding
    }
    if (request.kind === 'remove')
      state = { ...state, services: [], capabilitySelection: undefined }
    return state
  }),
  testClassification: vi.fn(async () => ({ ok: true }))
}
const Harness = (): React.JSX.Element => {
  const [view, navigate] = useState<ModelView>({ kind: 'classification' })
  return (
    <ModelPanel
      view={view}
      navigate={navigate}
      local={false}
      onChange={() => navigate({ kind: 'list' })}
    >
      <p>Chat provider fixture</p>
    </ModelPanel>
  )
}
beforeEach(async () => {
  await i18next.changeLanguage('en')
  state = { revision: 0, services: [], availableProviders: [] }
  vi.clearAllMocks()
  vi.stubGlobal('api', { settings: api })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('keeps classification optional, saves an account and binds the service independently', async () => {
  render(<Harness />)
  await screen.findByText('No model services added')
  expect(screen.queryByText('Chat provider fixture')).toBeNull()
  expect(screen.getByRole('combobox', { name: 'Automatic capability selection' }).textContent).toBe(
    'Use default method'
  )
  fireEvent.click(screen.getByText('Add service'))
  await screen.findByLabelText('API key')
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'secret-key' } })
  fireEvent.change(screen.getByLabelText('Service name'), { target: { value: 'Research account' } })
  fireEvent.click(screen.getByText('Save'))
  await screen.findByText('Research account')
  expect(screen.getByText('Key: ••••-key')).toBeTruthy()
  expect(api.updateClassification).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'save', apiKey: 'secret-key' })
  )
  expect(state.capabilitySelection).toBeUndefined()
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Automatic capability selection' }), {
    key: 'Enter'
  })
  fireEvent.click(await screen.findByRole('option', { name: 'Research account / Jev Latest' }))
  await waitFor(() => expect(state.capabilitySelection?.serviceId).toBeDefined())
  fireEvent.click(screen.getByRole('button', { name: 'Check model' }))
  await screen.findByText('Check passed')
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  expect(await screen.findByLabelText('API key')).toHaveProperty('value', '')
  fireEvent.click(screen.getByText('Remove service'))
  expect(api.updateClassification).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByText('Remove'))
  await screen.findByText('No model services added')
})
it('surfaces a load failure instead of presenting an unconfigured account', async () => {
  api.getClassification.mockRejectedValueOnce(new Error('unavailable'))
  render(<Harness />)
  await screen.findByRole('alert')
  expect(screen.queryByText('No model services added')).toBeNull()
  fireEvent.click(screen.getByText('Reload'))
  await screen.findByText('No model services added')
})

it('preserves the entered credential and fields after a failed save, and supports cancel', async () => {
  api.updateClassification.mockRejectedValueOnce(new Error('save failed'))
  render(<Harness />)
  fireEvent.click(await screen.findByText('Add service'))
  await screen.findByLabelText('API key')
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'unsaved-secret' } })
  expect(screen.getByLabelText('API key')).toHaveProperty('type', 'password')
  fireEvent.click(screen.getByRole('button', { name: 'Show API key' }))
  expect(screen.getByLabelText('API key')).toHaveProperty('type', 'text')
  fireEvent.click(screen.getByRole('button', { name: 'Hide API key' }))
  expect(screen.getByLabelText('API key')).toHaveProperty('type', 'password')
  fireEvent.change(screen.getByLabelText('Service name'), { target: { value: 'My account' } })
  fireEvent.click(screen.getByText('Save'))
  await screen.findByText('Could not save changes. Reload settings and try again.')
  expect(screen.getByLabelText('API key')).toHaveProperty('value', 'unsaved-secret')
  expect(screen.getByLabelText('Service name')).toHaveProperty('value', 'My account')
  fireEvent.click(screen.getByText('Cancel'))
  await screen.findByText('No model services added')
  expect(state.services).toEqual([])
})
it('offers provider choices and an API key link without a manual model ID field', async () => {
  render(<Harness />)
  fireEvent.click(await screen.findByText('Add service'))
  await screen.findByLabelText('API key')
  expect(screen.queryByLabelText('Model IDs')).toBeNull()
  expect(screen.getByRole('link', { name: 'Get an API key' }).getAttribute('href')).toBe(
    'https://console.typesafe.ai'
  )
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Provider' }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name: 'OpenRouter' }))
  expect(screen.getByRole('link', { name: 'Get an API key' }).getAttribute('href')).toBe(
    'https://openrouter.ai/workspaces/default/keys'
  )
})

it('configures a custom typed-decision endpoint without requiring a loopback key', async () => {
  render(<Harness />)
  fireEvent.click(await screen.findByText('Add service'))
  fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Provider' }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name: 'Custom HTTP service' }))
  expect(await screen.findByText(/Open-Science Typed Decisions HTTP/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Endpoint URL'), {
    target: { value: 'http://localhost:8000/classify' }
  })
  fireEvent.change(screen.getByLabelText('Model'), {
    target: { value: 'local-typed-decisions' }
  })
  fireEvent.change(screen.getByLabelText('Service name'), { target: { value: 'Local classifier' } })
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() =>
    expect(api.updateClassification).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: 'custom',
        baseUrl: 'http://localhost:8000/classify',
        modelId: 'local-typed-decisions',
        apiKey: undefined
      })
    )
  )
})
it('shows the shared validation failure without saving, preserves the draft, and allows retry', async () => {
  let finish!: (result: ClassificationMutationResult) => void
  api.updateClassification.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(<Harness />)
  fireEvent.click(await screen.findByText('Add service'))
  fireEvent.change(await screen.findByLabelText('API key'), {
    target: { value: 'synthetic-bad-key' }
  })
  fireEvent.click(screen.getByText('Save'))
  expect(await screen.findByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true)
  finish({ ...state, validation: { ok: false, category: 'auth', status: 401 } })
  expect(await screen.findByText('Authentication failed. Check the API key.')).toBeTruthy()
  expect(screen.getByText('Changes have not been saved.')).toBeTruthy()
  expect(screen.getByLabelText('API key')).toHaveProperty('value', 'synthetic-bad-key')
  expect(state.services).toEqual([])
  fireEvent.change(screen.getByLabelText('API key'), {
    target: { value: 'synthetic-corrected-key' }
  })
  expect(screen.queryByText('Connection test failed.')).toBeNull()
  fireEvent.click(screen.getByText('Save'))
  expect(await screen.findByRole('heading', { name: 'TypeSafe AI' })).toBeTruthy()
  expect(state.capabilitySelection).toBeUndefined()
})
it('shows the pending model check and actionable failure without changing the binding', async () => {
  state.services = [
    {
      id: 'account',
      name: 'Research',
      adapter: 'typesafe',
      configured: true
    }
  ]
  let finish: (result: { ok: boolean }) => void = () => undefined
  api.testClassification.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(<Harness />)
  fireEvent.click(await screen.findByRole('button', { name: 'Check model' }))
  expect(screen.getByRole('button', { name: 'Checking model…' })?.getAttribute('aria-busy')).toBe(
    'true'
  )
  finish({ ok: false })
  await screen.findByText('Model check failed')
  expect(screen.getByRole('alert').textContent).toContain(
    'Check the API key and network connection'
  )
  expect(state.capabilitySelection).toBeUndefined()
})

it('opens help on click and binds skills and connectors through one model selector', async () => {
  state.services = [{ id: 'account', name: 'Research', adapter: 'typesafe', configured: true }]
  render(<Harness />)
  const help = await screen.findByRole('button', { name: 'About classification models' })
  expect(screen.queryByText(/Available for main conversations/)).toBeNull()
  fireEvent.click(help)
  expect(await screen.findByRole('dialog', { name: 'About classification models' })).toBeTruthy()
  expect(screen.getByText(/Available for main conversations/)).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'About classification models' }), {
    key: 'Escape'
  })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Automatic capability selection' }), {
    key: 'Enter'
  })
  fireEvent.click(await screen.findByRole('option', { name: 'Research / Jev Latest' }))
  await waitFor(() =>
    expect(state.capabilitySelection).toEqual({ serviceId: 'account', modelId: 'jev-latest' })
  )
  expect(screen.getAllByRole('combobox')).toHaveLength(1)
})

it('reuses an existing OpenRouter account without displaying or resubmitting its key', async () => {
  state.availableProviders = [
    { id: 'shared-account', name: 'Research router', maskedKey: '••••1234' }
  ]
  render(<Harness />)
  fireEvent.click(await screen.findByText('Add service'))
  fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Provider' }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name: 'OpenRouter' }))
  expect((await screen.findByRole('combobox', { name: 'API key source' })).textContent).toContain(
    'Research router'
  )
  expect(screen.queryByLabelText('API key')).toBeNull()
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() =>
    expect(api.updateClassification).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: 'openrouter',
        providerId: 'shared-account',
        apiKey: undefined
      })
    )
  )
  expect(state.capabilitySelection).toBeUndefined()
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.click(await screen.findByText('Remove service'))
  expect(await screen.findByText(/keeps the shared account and key/)).toBeTruthy()
})
it('requires a new key when detaching a shared account', async () => {
  state.availableProviders = [{ id: 'shared-account', name: 'Research router' }]
  state.services = [
    {
      id: 'account',
      name: 'Linked',
      adapter: 'openrouter',
      providerId: 'shared-account',
      configured: true
    }
  ]
  render(<Harness />)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.keyDown(await screen.findByRole('combobox', { name: 'API key source' }), {
    key: 'Enter'
  })
  fireEvent.click(await screen.findByRole('option', { name: 'Use a new API key' }))
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'replacement-key' } })
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() =>
    expect(api.updateClassification).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: undefined, apiKey: 'replacement-key' })
    )
  )
})
