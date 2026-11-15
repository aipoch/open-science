import { useImageModelSettingsStore } from '@/stores/image-model-settings-store'
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import { ImageModelSelector, ImageServicesPanel } from './ImageModelSettings'
import { useImageModelSettings } from './use-image-model-settings'
import type {
  ImageModelSettingsMutation,
  ImageModelSettingsSnapshot
} from '../../../../shared/image-model-settings'

if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined
const snapshot: ImageModelSettingsSnapshot = {
  services: [],
  availableProviders: [
    {
      id: 'account',
      name: 'MiniMax China',
      vendorId: 'minimax',
      maskedKey: '••••1234',
      adapter: 'minimax',
      baseUrl: 'https://api.minimax.cn/v1',
      models: [
        {
          id: 'MiniMax-H3-Image',
          label: 'MiniMax H3 Image',
          wireModelId: 'MiniMax-H3-Image',
          presetId: 'minimax-h3/official'
        }
      ]
    }
  ]
}
const save = vi.fn<(request: ImageModelSettingsMutation) => Promise<ImageModelSettingsSnapshot>>(
  async () => snapshot
)
const navigate = vi.fn()
beforeEach(async () => {
  useImageModelSettingsStore.setState({ snapshot: undefined, loadFailed: false })
  await i18next.changeLanguage('en')
  vi.clearAllMocks()
  vi.stubGlobal('api', {
    settings: { getImageModels: vi.fn(async () => snapshot), updateImageModels: save }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('deletes an image service from its row only after confirmation', async () => {
  const { id, name, adapter, models } = snapshot.availableProviders[0]
  vi.mocked(window.api.settings.getImageModels).mockResolvedValue({
    ...snapshot,
    services: [{ id, name, providerId: id, adapter, models, configured: true }]
  })
  render(<ImageServicesPanel view={{ kind: 'image-services' }} navigate={navigate} />)
  const remove = await screen.findByRole('button', { name: 'Delete' })
  await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false))
  fireEvent.click(remove)
  const dialog = await screen.findByRole('alertdialog', { name: `Delete ${name}?` })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(remove)
  fireEvent.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
  )
  await screen.findByText('No model services added')
  expect(save).toHaveBeenCalledExactlyOnceWith({ kind: 'remove', id })
  expect(navigate).not.toHaveBeenCalled()
})

it('saves a keyless local service with distinct presets and navigates back only on success', async () => {
  const { rerender } = render(
    <ImageServicesPanel view={{ kind: 'image-service-create' }} navigate={navigate} />
  )
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Local images' } })
  fireEvent.change(screen.getByLabelText('Base URL'), {
    target: { value: 'http://localhost:3000/v1' }
  })
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'local/H3' } })
  fireEvent.pointerDown(screen.getByLabelText('Interface preset'), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.click(await screen.findByRole('option', { name: 'MiniMax H3 · SGLang' }))
  fireEvent.click(screen.getByText('Add model'))
  fireEvent.change(screen.getAllByLabelText('Model ID')[1], { target: { value: 'other/model' } })
  save.mockRejectedValueOnce(new Error('disk unavailable'))
  fireEvent.click(screen.getByText('Save'))
  await screen.findByText('Could not save changes. Reload settings and try again.')
  expect(screen.queryByText('Saved. New image settings apply from the next turn.')).toBeNull()
  expect(navigate).not.toHaveBeenCalled()
  expect(
    screen.getAllByLabelText('Model ID').map((input) => (input as HTMLInputElement).value)
  ).toEqual(['local/H3', 'other/model'])
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'image-services' }))
  rerender(<ImageServicesPanel view={{ kind: 'image-services' }} navigate={navigate} />)
  expect(screen.getByRole('status').textContent).toBe('Saved')
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: 'save',
      baseUrl: 'http://localhost:3000/v1',
      models: [
        expect.objectContaining({ wireModelId: 'local/H3', presetId: 'minimax-h3/sglang' }),
        expect.objectContaining({ wireModelId: 'other/model', presetId: 'openai-images/generic' })
      ]
    })
  )
})

it('announces a committed selection, clears stale success on failure and confirms disabling', async () => {
  const configured: ImageModelSettingsSnapshot = {
    ...snapshot,
    services: [
      {
        id: 'local',
        name: 'Local images',
        adapter: 'openai-images',
        baseUrl: 'http://localhost:3000/v1',
        configured: true,
        models: [{ id: 'model', wireModelId: 'local/image', presetId: 'openai-images/generic' }]
      }
    ]
  }
  vi.mocked(window.api.settings.getImageModels).mockResolvedValue(configured)
  const Selector = (): React.JSX.Element => (
    <ImageModelSelector state={useImageModelSettings()} onManage={navigate} />
  )
  render(<Selector />)
  const select = await screen.findByLabelText('Image generation model')
  await waitFor(() => expect(select.hasAttribute('disabled')).toBe(false))
  expect(screen.queryByRole('status')).toBeNull()
  let complete!: (value: ImageModelSettingsSnapshot) => void
  save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  fireEvent.pointerDown(select, { button: 0, pointerType: 'mouse', ctrlKey: false })
  fireEvent.click(await screen.findByRole('option', { name: 'Local images · local/image' }))
  expect(screen.queryByRole('status')).toBeNull()
  await waitFor(() => expect(complete).toBeTypeOf('function'))
  complete({ ...configured, imageModel: { serviceId: 'local', modelId: 'model' } })
  await screen.findByRole('status')
  save.mockRejectedValueOnce(new Error('write failed'))
  fireEvent.pointerDown(select, { button: 0, pointerType: 'mouse', ctrlKey: false })
  fireEvent.click(await screen.findByRole('option', { name: 'Not configured' }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('status')).toBeNull()
  expect(select.textContent).toContain('Local images')
  save.mockResolvedValueOnce(configured)
  fireEvent.pointerDown(select, { button: 0, pointerType: 'mouse', ctrlKey: false })
  fireEvent.click(await screen.findByRole('option', { name: 'Not configured' }))
  await screen.findByRole('status')
  expect(select.textContent).toBe('Not configured')
})

it('discards typed custom credentials when switching to an official account', async () => {
  render(<ImageServicesPanel view={{ kind: 'image-service-create' }} navigate={navigate} />)
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Official images' } })
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'must-not-be-sent' } })
  fireEvent.pointerDown(screen.getByLabelText('Provider type'), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.click(await screen.findByRole('option', { name: 'MiniMax' }))
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('••••1234')
  expect(screen.queryByLabelText('Base URL')).toBeNull()
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'save',
      providerId: 'account',
      adapter: 'minimax',
      models: snapshot.availableProviders[0].models
    })
  )
  expect(save.mock.calls[0][0]).not.toHaveProperty('apiKey')
  expect(save.mock.calls[0][0]).not.toHaveProperty('baseUrl')
})

it('switches provider models without carrying custom credentials and uses the account name by default', async () => {
  render(<ImageServicesPanel view={{ kind: 'image-service-create' }} navigate={navigate} />)
  const providerSelect = await screen.findByLabelText('Provider type')
  fireEvent.change(screen.getByLabelText('Base URL'), {
    target: { value: 'http://localhost:3000/v1' }
  })
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'local/image' } })
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'draft-secret' } })
  fireEvent.click(screen.getByLabelText('Show API key'))
  fireEvent.pointerDown(providerSelect, { button: 0, pointerType: 'mouse', ctrlKey: false })
  fireEvent.click(await screen.findByRole('option', { name: 'MiniMax' }))
  expect(screen.getByText('Supported models')).toBeTruthy()
  expect(screen.getByTitle('MiniMax-H3-Image')).toBeTruthy()
  expect(screen.queryByLabelText('Model ID')).toBeNull()
  fireEvent.pointerDown(providerSelect, { button: 0, pointerType: 'mouse', ctrlKey: false })
  fireEvent.click(await screen.findByRole('option', { name: 'Custom HTTP service' }))
  expect(screen.queryByText('Supported models')).toBeNull()
  expect((screen.getByLabelText('Model ID') as HTMLInputElement).value).toBe('local/image')
  const key = screen.getByLabelText('API key') as HTMLInputElement
  expect(key.value).toBe('')
  expect(key.type).toBe('password')
  fireEvent.pointerDown(providerSelect, { button: 0, pointerType: 'mouse', ctrlKey: false })
  fireEvent.click(await screen.findByRole('option', { name: 'MiniMax' }))
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'MiniMax', providerId: 'account' })
  )
})

it.each([
  ['OpenAI', 'openai', 'GPT Image 2.6 Sunburst', 'openai-images'],
  ['Bailian', 'bailian', 'Qwen Image 3.0 Pro', 'qwen-images'],
  ['Volcengine Ark', 'volcengine', 'Seedream 5.5', 'seedream']
])('configures %s without a conversation account', async (label, vendorId, model, adapter) => {
  render(<ImageServicesPanel view={{ kind: 'image-service-create' }} navigate={navigate} />)
  fireEvent.pointerDown(await screen.findByLabelText('Provider type'), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.click(await screen.findByRole('option', { name: label }))
  expect(screen.getByText(model)).toBeTruthy()
  expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'image-only-secret' } })
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ vendorId, adapter, apiKey: 'image-only-secret' })
  )
  expect(save.mock.calls[0][0]).not.toHaveProperty('providerId')
})

it('switches a reused credential to a separate image key without modifying the account', async () => {
  render(<ImageServicesPanel view={{ kind: 'image-service-create' }} navigate={navigate} />)
  fireEvent.pointerDown(await screen.findByLabelText('Provider type'), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.click(await screen.findByRole('option', { name: 'MiniMax' }))
  fireEvent.pointerDown(screen.getByLabelText('Credentials'), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.click(await screen.findByRole('option', { name: 'Separate API key' }))
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'separate-secret' } })
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0][0]).toMatchObject({ vendorId: 'minimax', apiKey: 'separate-secret' })
  expect(save.mock.calls[0][0]).not.toHaveProperty('providerId')
})

it('omits the preset selector when the API format has only one contract', async () => {
  render(<ImageServicesPanel view={{ kind: 'image-service-create' }} navigate={navigate} />)
  fireEvent.pointerDown(await screen.findByLabelText('API format'), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.click(await screen.findByRole('option', { name: 'MiniMax' }))
  expect(screen.queryByLabelText('Interface preset')).toBeNull()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local MiniMax' } })
  fireEvent.change(screen.getByLabelText('Base URL'), {
    target: { value: 'http://localhost:3000/v1' }
  })
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'local-h3' } })
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: 'minimax',
        models: [expect.objectContaining({ presetId: 'minimax-h3/official' })]
      })
    )
  )
})
