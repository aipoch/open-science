// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PdfTranslationControls } from './PdfTranslationControls'
import { createPdfTranslationSource } from './pdf-translation'
import type { PdfTranslationJob } from './use-pdf-translation-job'
import { useSettingsStore } from '@/stores/settings-store'
import type { ProviderView } from '../../../../../../shared/settings'
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
const initialSettings = useSettingsStore.getState()
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useSettingsStore.setState(initialSettings)
})
const executor = {
  targets: [{ id: 'remote', label: 'Chosen model', mode: 'agent' as const }],
  translate: vi.fn()
}
const idle: PdfTranslationJob = { status: 'idle', done: 0, total: 0 }

const apiProvider: ProviderView = {
  id: 'api-provider',
  name: 'API provider',
  type: 'custom',
  baseUrl: 'https://example.test',
  apiEndpoints: ['openai'],
  models: ['first-model', 'second-model'],
  hasKey: true,
  needsKey: false,
  supportsImageInput: false
}
const apiExecutor = {
  targets: [
    { id: 'api', label: 'Direct API', mode: 'api' as const },
    { id: 'agent', label: 'Agent', mode: 'agent' as const }
  ],
  translate: vi.fn()
}

it('selects an Agent model for this translation without changing global settings', () => {
  useSettingsStore.setState({
    providers: [apiProvider],
    activeProviderId: apiProvider.id,
    activeModel: 'first-model',
    agentFrameworkId: 'opencode',
    agentFrameworks: [
      {
        id: 'opencode',
        displayName: 'OpenCode',
        supportedApiTypes: ['openai'],
        supportsSkills: true
      }
    ]
  })
  const onStart = vi.fn()
  render(
    <PdfTranslationControls
      executor={apiExecutor}
      ready
      hasTranslatableText
      state={idle}
      onStart={onStart}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Agent' }))
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'second-model · API provider' }))
  fireEvent.click(screen.getByRole('button', { name: 'Translate document' }))
  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      targetId: 'agent',
      agentModel: {
        frameworkId: 'opencode',
        providerId: apiProvider.id,
        modelId: 'second-model',
        reasoningEffort: 'default'
      }
    })
  )
  expect(useSettingsStore.getState().activeModel).toBe('first-model')
  expect(useSettingsStore.getState().activeProviderId).toBe(apiProvider.id)
  act(() => useSettingsStore.setState({ providers: [] }))
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Translate document' }).disabled
  ).toBe(true)
})

it('allows an Agent translation to return to the main model without retaining a hidden override', () => {
  useSettingsStore.setState({
    providers: [apiProvider],
    agentFrameworkId: 'opencode',
    agentFrameworks: [
      {
        id: 'opencode',
        displayName: 'OpenCode',
        supportedApiTypes: ['openai'],
        supportsSkills: true
      }
    ]
  })
  const onStart = vi.fn()
  render(
    <PdfTranslationControls
      executor={apiExecutor}
      ready
      hasTranslatableText
      state={idle}
      onStart={onStart}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Agent' }))
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'second-model · API provider' }))
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Main model' }))
  fireEvent.click(screen.getByRole('button', { name: 'Translate document' }))
  expect(onStart.mock.calls[0][0]).not.toHaveProperty('agentModel')
})

it('shows the current main model when a new translation switches from an older API run to Agent', () => {
  useSettingsStore.setState({
    providers: [apiProvider],
    activeProviderId: apiProvider.id,
    activeModel: 'first-model'
  })
  render(
    <PdfTranslationControls
      executor={apiExecutor}
      ready
      hasTranslatableText
      state={{
        status: 'completed',
        done: 1,
        total: 1,
        options: {
          targetId: 'api',
          language: 'Chinese',
          glossary: [],
          apiModel: { providerId: apiProvider.id, modelId: 'second-model' }
        },
        model: { frameworkId: 'direct-api', modelId: 'second-model', mode: 'api' }
      }}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'New translation' }))
  const dialog = screen.getByRole('dialog', { name: 'New translation' })
  fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Agent' }))
  expect(within(dialog).getByText(/Main model: first-model/)).toBeTruthy()
  expect(within(dialog).queryByText(/Main model: second-model/)).toBeNull()
})

it('requires an available API model and never selects the active subscription implicitly', () => {
  useSettingsStore.setState({
    activeProviderId: 'subscription',
    activeModel: 'subscription-model',
    providers: [
      apiProvider,
      { ...apiProvider, id: 'subscription', type: 'codex-isolated', models: ['subscription-model'] }
    ]
  })
  const onStart = vi.fn()
  render(
    <PdfTranslationControls
      executor={apiExecutor}
      ready
      hasTranslatableText
      state={idle}
      onStart={onStart}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Direct API' }))
  const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Translate document' })
  expect(start.disabled).toBe(true)
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' })
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'first-model · API provider',
    'second-model · API provider'
  ])
  fireEvent.click(screen.getByRole('option', { name: 'second-model · API provider' }))
  expect(start.disabled).toBe(false)
  fireEvent.click(start)
  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      targetId: 'api',
      apiModel: { providerId: 'api-provider', modelId: 'second-model' }
    })
  )
  expect(useSettingsStore.getState().activeProviderId).toBe('subscription')
  act(() => useSettingsStore.setState({ providers: [] }))
  expect(start.disabled).toBe(true)
})

it('explains the disabled model picker when only subscriptions are configured', async () => {
  useSettingsStore.setState({ providers: [{ ...apiProvider, type: 'claude-shared' }] })
  render(
    <PdfTranslationControls
      executor={apiExecutor}
      ready
      hasTranslatableText
      state={idle}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Direct API' }))
  expect(screen.getByRole<HTMLButtonElement>('combobox', { name: 'Model' }).disabled).toBe(true)
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Translate document' }).disabled
  ).toBe(true)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.pointerMove(screen.getByRole('group', { name: 'Model' }), { pointerType: 'mouse' })
  expect(await screen.findByRole('tooltip')).toHaveProperty(
    'textContent',
    'No available API models. Configure an API provider in Settings.'
  )
})

it('keeps API guidance in a tooltip and explains an unavailable model option', async () => {
  useSettingsStore.setState({ providers: [apiProvider] })
  const onStart = vi.fn()
  render(
    <PdfTranslationControls
      executor={apiExecutor}
      ready
      hasTranslatableText
      state={idle}
      onStart={onStart}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Direct API' }))
  expect(
    screen.queryByText('Direct API only supports API models. Subscription models must use Agent.')
  ).toBeNull()
  const info = screen.getByRole('button', { name: 'Model settings' })
  fireEvent.focus(info)
  expect(await screen.findByRole('tooltip')).toHaveProperty(
    'textContent',
    'Direct API only supports API models. Subscription models must use Agent.'
  )
  fireEvent.blur(info)
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('option', { name: 'second-model · API provider' }))
  act(() => useSettingsStore.setState({ providers: [{ ...apiProvider, models: ['first-model'] }] }))
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' })
  const unavailable = screen.getByRole('option', { name: 'second-model · Unavailable' })
  expect(unavailable.getAttribute('aria-disabled')).toBe('true')
  expect(unavailable.className).toContain('data-[disabled]:pointer-events-auto')
  fireEvent.pointerMove(unavailable, { pointerType: 'mouse' })
  expect(await screen.findByRole('tooltip')).toHaveProperty(
    'textContent',
    'The selected model is no longer available. Select another model or check its configuration in Settings.'
  )
  fireEvent.click(unavailable)
  expect(screen.getByRole('listbox')).toBeTruthy()
  expect(onStart).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('option', { name: 'first-model · API provider' }))
  fireEvent.click(screen.getByRole('button', { name: 'Translate document' }))
  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({ apiModel: { providerId: 'api-provider', modelId: 'first-model' } })
  )
})

it('continues with the saved API model even when the main model changed', () => {
  useSettingsStore.setState({ providers: [apiProvider], activeProviderId: 'another-provider' })
  const options = {
    targetId: 'api',
    language: 'Chinese',
    glossary: [],
    apiModel: { providerId: 'api-provider', modelId: 'second-model' }
  }
  const onStart = vi.fn()
  render(
    <PdfTranslationControls
      executor={apiExecutor}
      ready
      hasTranslatableText
      state={{ status: 'cancelled', done: 1, total: 2, options }}
      onStart={onStart}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Continue translation' })
  expect(start.disabled).toBe(false)
  fireEvent.click(start)
  expect(onStart).toHaveBeenCalledWith(options)
  act(() => useSettingsStore.setState({ providers: [{ ...apiProvider, models: ['first-model'] }] }))
  expect(start.disabled).toBe(true)
})

it('starts with a locale-aware language and supports searchable or free-form values', () => {
  render(
    <PdfTranslationControls
      executor={executor}
      ready
      hasTranslatableText
      state={idle}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  expect(
    screen.getByRole('button', { name: /Translation settings/ }).parentElement?.className
  ).toContain('overflow-visible')
  const input = screen.getByLabelText('Target language') as HTMLInputElement
  expect(input.value).toBe('English')
  const languageTrigger = screen.getByRole('button', { name: 'Show target languages' })
  fireEvent.mouseDown(languageTrigger)
  fireEvent.click(languageTrigger)
  expect(languageTrigger.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('option', { name: 'English' })).toBeTruthy()
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'Chinese',
    'Dutch',
    'English',
    'French',
    'German',
    'Italian',
    'Japanese',
    'Portuguese',
    'Russian',
    'Spanish'
  ])
  fireEvent.click(input)
  expect(screen.getByRole('option', { name: 'English' })).toBeTruthy()
  fireEvent.change(input, { target: { value: 'Japa' } })
  expect(screen.getByRole('option', { name: 'Japanese' })).toBeTruthy()
  fireEvent.click(screen.getByRole('option', { name: 'Japanese' }))
  expect(input.value).toBe('Japanese')
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.change(input, { target: { value: 'Esperanto' } })
  expect(screen.getByText(/No matching languages/)).toBeTruthy()
  expect(screen.queryByText(/You can use the entered language/)).toBeNull()
})

it.each(['Arabic', 'Hindi', 'Korean', '한국어', 'Unrecognized language'])(
  'blocks unsupported %s before starting and explains how to choose another language',
  (language) => {
    const onStart = vi.fn()
    render(
      <PdfTranslationControls
        executor={executor}
        ready
        hasTranslatableText
        state={idle}
        onStart={onStart}
        onCancel={vi.fn()}
        onNewTranslation={vi.fn()}
      />
    )
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
      key: 'ArrowDown'
    })
    fireEvent.click(screen.getByRole('option', { name: 'Chosen model' }))
    fireEvent.change(screen.getByLabelText('Target language'), { target: { value: language } })
    const action = screen.getByRole<HTMLButtonElement>('button', { name: 'Translate document' })
    expect(action.disabled).toBe(true)
    expect(action.parentElement?.getAttribute('aria-label')).toBe(
      'This target language is not supported for translated PDFs. Choose a supported language.'
    )
    fireEvent.click(action)
    expect(onStart).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Target language'), { target: { value: '日本語' } })
    expect(action.disabled).toBe(false)
    fireEvent.click(action)
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ language: '日本語' }))
  }
)

it.each(['cancelled', 'error'] as const)(
  'keeps historical unsupported text intact while blocking %s continuation and new unsupported editions',
  (status) => {
    const onStart = vi.fn(),
      onNewTranslation = vi.fn()
    render(
      <PdfTranslationControls
        executor={executor}
        ready
        hasTranslatableText
        state={{
          status,
          done: 1,
          total: 2,
          options: {
            targetId: 'remote',
            language: 'Korean',
            glossary: [{ source: 'cell', target: '세포' }]
          }
        }}
        onStart={onStart}
        onCancel={vi.fn()}
        onNewTranslation={onNewTranslation}
      />
    )
    const action = screen.getByRole<HTMLButtonElement>('button', {
      name: status === 'cancelled' ? 'Continue translation' : 'Retry'
    })
    expect(action.disabled).toBe(true)
    expect(action.parentElement?.getAttribute('aria-label')).toContain('not supported')
    fireEvent.click(action)
    expect(onStart).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'New translation' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New translation' }))
    const start = dialog.getByRole<HTMLButtonElement>('button', { name: 'Translate document' })
    expect(start.disabled).toBe(true)
    expect(start.parentElement?.getAttribute('aria-label')).toContain('not supported')
    fireEvent.click(start)
    expect(onNewTranslation).not.toHaveBeenCalled()
    fireEvent.change(dialog.getByLabelText('Target language'), { target: { value: '繁體中文' } })
    expect(start.disabled).toBe(false)
    fireEvent.click(start)
    expect(onNewTranslation).toHaveBeenCalledWith(expect.objectContaining({ language: '繁體中文' }))
    expect(onStart).not.toHaveBeenCalled()
  }
)

it('opens translation settings when preparation becomes ready', () => {
  const view = render(
    <PdfTranslationControls
      executor={executor}
      ready={false}
      hasTranslatableText
      state={idle}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  const settings = (): HTMLElement => screen.getByRole('button', { name: /Translation settings/ })
  fireEvent.click(settings())
  expect(settings().getAttribute('aria-expanded')).toBe('false')
  view.rerender(
    <PdfTranslationControls
      executor={executor}
      ready
      hasTranslatableText
      state={idle}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  expect(settings().getAttribute('aria-expanded')).toBe('true')
})

it('repairs an incomplete saved language without disabling the combobox', () => {
  render(
    <PdfTranslationControls
      executor={{
        targets: [{ id: 'api', label: 'Direct API', mode: 'api' as const }],
        translate: vi.fn()
      }}
      ready
      hasTranslatableText
      state={{
        status: 'cancelled',
        done: 0,
        total: 1,
        options: { targetId: 'api', language: '', glossary: [] }
      }}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  expect(screen.getByText('Translation paused')).toBeTruthy()
  const input = screen.getByLabelText('Target language') as HTMLInputElement
  const trigger = screen.getByRole('button', { name: 'Show target languages' }) as HTMLButtonElement
  expect(input.value).toBe('English')
  expect(input.disabled).toBe(false)
  expect(trigger.disabled).toBe(false)
  fireEvent.click(trigger)
  expect(screen.getByRole('option', { name: 'English' })).toBeTruthy()
})

it('has no executable action without a real capability', () => {
  render(
    <PdfTranslationControls
      ready
      hasTranslatableText
      state={idle}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText(/No translation engine/)).toBeTruthy()
})
it('requires explicit model and language, discloses remote text transfer and passes the glossary', () => {
  const onStart = vi.fn()
  render(
    <PdfTranslationControls
      executor={executor}
      ready
      hasTranslatableText
      state={idle}
      onStart={onStart}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  const start = screen.getByRole('button', { name: 'Translate document' }) as HTMLButtonElement
  expect(start.disabled).toBe(true)
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Chosen model' }))
  expect(screen.getByRole('button', { name: 'Translation data usage' })).toBeTruthy()
  expect(start.disabled).toBe(false)
  fireEvent.change(screen.getByLabelText('Target language'), { target: { value: 'Chinese' } })
  fireEvent.click(screen.getByText('Translation glossary', { selector: 'button' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add term' }))
  expect(start.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Source term 1'), { target: { value: ' cell ' } })
  fireEvent.change(screen.getByLabelText('Preferred translation 1'), {
    target: { value: ' 细胞 ' }
  })
  expect(start.disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Add term' }))
  fireEvent.change(screen.getByLabelText('Source term 2'), { target: { value: 'cell' } })
  fireEvent.change(screen.getByLabelText('Preferred translation 2'), {
    target: { value: '另一译法' }
  })
  expect(start.disabled).toBe(true)
  expect(screen.getByText('Each source term must appear only once in the glossary.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove glossary term 2' }))
  expect(start.disabled).toBe(false)
  fireEvent.click(start)
  expect(onStart).toHaveBeenCalledWith({
    targetId: 'remote',
    language: 'Chinese',
    glossary: [{ source: 'cell', target: '细胞' }]
  })
})
it('pins retry settings, reports retained progress and exposes cancel and new translation at the right times', () => {
  const onStart = vi.fn(),
    onCancel = vi.fn(),
    onNewTranslation = vi.fn()
  const options = {
    targetId: 'remote',
    language: 'Chinese',
    glossary: [{ source: 'cell', target: '细胞' }]
  }
  const props = {
    executor,
    ready: true,
    hasTranslatableText: true,
    onStart,
    onCancel,
    onNewTranslation
  }
  const view = render(
    <PdfTranslationControls {...props} state={{ status: 'running', done: 1, total: 2, options }} />
  )
  expect(
    screen.getByRole('button', { name: /Translation settings/ }).getAttribute('aria-expanded')
  ).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: /Translation settings/ }))
  expect((screen.getByLabelText('Translation method') as HTMLSelectElement).disabled).toBe(true)
  expect((screen.getByLabelText('Source term 1') as HTMLInputElement).value).toBe('cell')
  expect((screen.getByLabelText('Preferred translation 1') as HTMLInputElement).value).toBe('细胞')
  expect(screen.getByLabelText('Source term 1').closest('fieldset')?.disabled).toBe(true)
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onCancel).toHaveBeenCalledOnce()
  view.rerender(
    <PdfTranslationControls {...props} state={{ status: 'error', done: 1, total: 2, options }} />
  )
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.getByLabelText('Paragraphs translated: 1 / 2')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onStart).toHaveBeenCalledWith(options)
  fireEvent.click(screen.getByRole('button', { name: 'New translation' }))
  const choice = within(screen.getByRole('dialog'))
  expect((choice.getByLabelText('Target language') as HTMLInputElement).value).toBe('Chinese')
  expect(onNewTranslation).not.toHaveBeenCalled()
  fireEvent.click(choice.getByRole('button', { name: 'Cancel' }))
  expect(onNewTranslation).not.toHaveBeenCalled()
  view.rerender(
    <PdfTranslationControls
      {...props}
      state={{ status: 'completed', done: 2, total: 2, options }}
    />
  )
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(
    screen
      .getByRole('button', { name: /Translation settings/ })
      .querySelector('[aria-label="Text translation complete"]')
  ).not.toBeNull()
  expect(screen.queryByText('Paragraphs translated: 2 / 2')).toBeNull()
  expect(screen.queryByText(/Keep the same model when retrying/)).toBeNull()
})

it.each(['completed', 'cancelled', 'error'] as const)(
  'confirms replacement of a %s translation without clearing it first',
  (status) => {
    const onNewTranslation = vi.fn()
    const options = {
      targetId: 'remote',
      language: 'Chinese',
      glossary: [{ source: 'cell', target: '细胞' }]
    }
    render(
      <PdfTranslationControls
        executor={executor}
        ready
        hasTranslatableText
        state={{
          status,
          done: 2,
          total: 2,
          options,
          model: { frameworkId: 'test', modelId: 'chosen-model' }
        }}
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onNewTranslation={onNewTranslation}
      />
    )
    const settingsButton = screen.getByRole('button', { name: /Translation settings/ })
    const newTranslationButton = screen.getByRole('button', { name: 'New translation' })
    expect(
      settingsButton.compareDocumentPosition(newTranslationButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Translation settings/ }))
    expect(screen.getByText('Chosen model')).toBeTruthy()
    if (status === 'completed') {
      expect(screen.getByText('Translation glossary').tagName).toBe('DT')
      expect(screen.getByText('cell → 细胞').tagName).toBe('DD')
      expect(screen.queryByLabelText('Translation glossary')).toBeNull()
    }
    fireEvent.click(screen.getByRole('button', { name: 'New translation' }))
    const choice = within(screen.getByRole('dialog'))
    const input = choice.getByLabelText('Target language') as HTMLInputElement
    expect(input.value).toBe('Chinese')
    expect(onNewTranslation).not.toHaveBeenCalled()
    expect(choice.getByRole('combobox', { name: 'Translation method' }).textContent).toContain(
      'Chosen model'
    )
    expect((choice.getByLabelText('Source term 1') as HTMLInputElement).value).toBe('cell')
    expect((choice.getByLabelText('Preferred translation 1') as HTMLInputElement).value).toBe(
      '细胞'
    )
    expect(choice.queryByRole('listbox')).toBeNull()
    fireEvent.change(input, { target: { value: 'French' } })
    fireEvent.click(choice.getByRole('button', { name: 'Cancel' }))
    expect(onNewTranslation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'New translation' }))
    const reopened = within(screen.getByRole('dialog'))
    expect((reopened.getByLabelText('Target language') as HTMLInputElement).value).toBe('Chinese')
    fireEvent.change(reopened.getByLabelText('Target language'), { target: { value: 'French' } })
    fireEvent.click(reopened.getByRole('button', { name: 'Translate document' }))
    expect(onNewTranslation).toHaveBeenCalledExactlyOnceWith({ ...options, language: 'French' })
    expect(screen.queryByRole('dialog')).toBeNull()
  }
)

it('explains when prepared text has no translatable paragraphs and keeps the action disabled', () => {
  render(
    <PdfTranslationControls
      executor={executor}
      ready
      hasTranslatableText={false}
      state={idle}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  expect(screen.getByText(/No eligible paragraphs/)).toBeTruthy()
  expect(
    (screen.getByRole('button', { name: 'Translate document' }) as HTMLButtonElement).disabled
  ).toBe(true)
})

it('does not round an unfinished document up to 100 percent', () => {
  render(
    <PdfTranslationControls
      executor={executor}
      ready
      hasTranslatableText
      state={{ status: 'running', done: 487, total: 488 }}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('99')
  expect(screen.queryByText('100%')).toBeNull()
})

it('displays the admitted model and actionable timeout without provider error text', () => {
  render(
    <PdfTranslationControls
      executor={{ ...executor, targets: [{ id: 'agent', label: 'Agent', mode: 'agent' }] }}
      ready
      hasTranslatableText
      state={{
        status: 'error',
        done: 1,
        total: 2,
        failure: 'timeout',
        options: { targetId: 'agent', language: 'Chinese', glossary: [] },
        model: { frameworkId: 'claude-code', modelId: 'test-model' }
      }}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: /Translation settings/ }))
  expect(screen.getByText(/Main model: test-model/)).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('took too long')
})

it('uses asynchronously restored settings and requires an available model before confirmation', () => {
  const onNewTranslation = vi.fn()
  const props = {
    executor,
    ready: true,
    hasTranslatableText: true,
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onNewTranslation
  }
  const view = render(<PdfTranslationControls {...props} state={idle} />)
  view.rerender(
    <PdfTranslationControls
      {...props}
      state={{
        status: 'completed',
        done: 1,
        total: 1,
        options: {
          targetId: 'removed-model',
          language: 'Japanese',
          glossary: [{ source: 'custom term', target: 'custom term' }],
          checkpoint: { key: 'old', revision: 2 },
          expectedTargetKey: 'old-model'
        }
      }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'New translation' }))
  const dialog = within(screen.getByRole('dialog'))
  expect((dialog.getByLabelText('Target language') as HTMLInputElement).value).toBe('Japanese')
  const confirm = dialog.getByRole('button', { name: 'Translate document' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.keyDown(dialog.getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Chosen model' }))
  expect(confirm.disabled).toBe(false)
  fireEvent.change(dialog.getByLabelText('Target language'), { target: { value: ' ' } })
  expect(confirm.disabled).toBe(true)
  fireEvent.change(dialog.getByLabelText('Target language'), { target: { value: 'Japanese' } })
  fireEvent.click(confirm)
  expect(onNewTranslation).toHaveBeenCalledExactlyOnceWith({
    targetId: 'remote',
    language: 'Japanese',
    glossary: [{ source: 'custom term', target: 'custom term' }]
  })
})

it('dismisses the language list before the new translation dialog without closing its parent', () => {
  const onParentKeyDown = vi.fn(),
    onNewTranslation = vi.fn()
  render(
    <div onKeyDown={onParentKeyDown}>
      <PdfTranslationControls
        executor={executor}
        ready
        hasTranslatableText
        state={{
          status: 'completed',
          done: 1,
          total: 1,
          options: { targetId: 'remote', language: 'Chinese', glossary: [] }
        }}
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onNewTranslation={onNewTranslation}
      />
    </div>
  )
  const trigger = screen.getByRole('button', { name: 'New translation' })
  fireEvent.click(trigger)
  const input = within(screen.getByRole('dialog')).getByLabelText('Target language')
  fireEvent.click(input)
  expect(screen.getByRole('listbox')).toBeTruthy()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(onParentKeyDown).not.toHaveBeenCalled()
  expect(onNewTranslation).not.toHaveBeenCalled()
})

it.each([true, false])(
  'shows expandable diagnostics for provider or Agent failures (provider=%s)',
  (provider) => {
    const onStart = vi.fn()
    const options = { targetId: executor.targets[0].id, language: 'Chinese', glossary: [] }
    const { container } = render(
      <PdfTranslationControls
        executor={executor}
        ready
        hasTranslatableText
        state={{
          status: 'error',
          done: 1,
          total: 2,
          failure: 'unknown',
          options,
          errorDetails: provider
            ? 'HTTP 529: synthetic overload diagnostic'
            : 'Agent transport: synthetic connection failure',
          ...(provider ? { providerFailure: { kind: 'unavailable', status: 529 } } : {})
        }}
        onStart={onStart}
        onCancel={vi.fn()}
        onNewTranslation={vi.fn()}
      />
    )
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('Details')
    expect(details.textContent).toContain(provider ? 'HTTP 529' : 'Agent transport')
    if (provider) {
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByText('Translation paused')).toBeTruthy()
      expect(screen.queryByText('Some paragraphs could not be translated.')).toBeNull()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onStart).toHaveBeenCalledWith(options)
  }
)

it('makes continuation primary and keeps restart secondary for an interrupted translation', () => {
  const onStart = vi.fn()
  const options = { targetId: 'remote', language: 'Chinese', glossary: [] }
  render(
    <PdfTranslationControls
      executor={executor}
      ready
      hasTranslatableText
      state={{ status: 'cancelled', done: 103, total: 209, options }}
      onStart={onStart}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  expect(screen.getByText('103 / 209')).toBeTruthy()
  expect(screen.queryByText('Translation is incomplete. Completed paragraphs are kept.')).toBeNull()
  const resume = screen.getByRole('button', { name: 'Continue translation' })
  const restart = screen.getByRole('button', { name: 'New translation' })
  expect(resume.className).toContain('bg-primary')
  expect(restart.className).not.toContain('bg-primary')
  expect(resume.closest('.flex-wrap')).toBe(restart.closest('.flex-wrap'))
  fireEvent.click(resume)
  expect(onStart).toHaveBeenCalledWith(options)
})

it('marks a finished run with skipped blocks as an issue rather than fully translated', () => {
  render(
    <PdfTranslationControls
      executor={executor}
      ready
      hasTranslatableText
      state={{
        status: 'completed',
        done: 0,
        total: 1,
        options: { targetId: 'remote', language: 'Chinese', glossary: [] },
        results: {
          source: createPdfTranslationSource({
            resourceRequestKey: 'r',
            fingerprint: 'f',
            pages: [],
            units: []
          }),
          units: [],
          failedUnitIds: ['failed']
        }
      }}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  expect(screen.getByLabelText('Translation failed')).toBeTruthy()
  expect(screen.queryByLabelText('Text translation complete')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('keeps advanced options collapsed, defaults to serial and starts with four lanes', () => {
  const onNewTranslation = vi.fn()
  render(
    <PdfTranslationControls
      executor={executor}
      ready
      hasTranslatableText
      state={{
        status: 'cancelled',
        done: 0,
        total: 1,
        options: { targetId: 'remote', language: 'Chinese', glossary: [] }
      }}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={onNewTranslation}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'New translation' }))
  const dialog = within(screen.getByRole('dialog'))
  const advanced = dialog.getByRole('button', { name: 'Advanced' })
  expect(advanced.getAttribute('aria-expanded')).toBe('false')
  expect(dialog.queryByRole('combobox', { name: 'Concurrent translations' })).toBeNull()
  fireEvent.click(advanced)
  const select = dialog.getByRole('combobox', { name: 'Concurrent translations' })
  expect(select.textContent).toBe('1x (serial)')
  fireEvent.keyDown(select, { key: 'ArrowDown' })
  expect(screen.getAllByRole('option').map((item) => item.textContent)).toEqual([
    '1x (serial)',
    '2x',
    '4x'
  ])
  fireEvent.click(screen.getByRole('option', { name: '4x' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Translate document' }))
  expect(onNewTranslation).toHaveBeenCalledWith({
    targetId: 'remote',
    language: 'Chinese',
    glossary: [],
    concurrency: 4
  })
})

it('offers skip and continue only for an identified failed paragraph with skip support', () => {
  const onSkip = vi.fn()
  const props = {
    executor,
    ready: true,
    hasTranslatableText: true,
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onNewTranslation: vi.fn(),
    onSkip,
    state: {
      status: 'error' as const,
      done: 1,
      total: 3,
      failure: 'timeout' as const,
      failedUnitId: 'paragraph-2',
      options: { targetId: 'remote', language: 'Chinese', glossary: [] }
    }
  }
  const { rerender } = render(<PdfTranslationControls {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Skip and continue' }))
  expect(onSkip).toHaveBeenCalledWith('paragraph-2')
  rerender(
    <PdfTranslationControls {...props} state={{ ...props.state, failedUnitId: undefined }} />
  )
  expect(screen.queryByRole('button', { name: 'Skip and continue' })).toBeNull()
  rerender(<PdfTranslationControls {...props} onSkip={undefined} />)
  expect(screen.queryByRole('button', { name: 'Skip and continue' })).toBeNull()
})

it.each([
  { ready: false, hasTranslatableText: true, reason: 'Prepare full text before translating.' },
  {
    ready: true,
    hasTranslatableText: false,
    reason: 'No eligible paragraphs were found in the prepared text.'
  },
  { ready: true, hasTranslatableText: true, reason: 'Select a translation method to continue.' }
])(
  'explains the disabled start action: $reason',
  async ({ ready, hasTranslatableText, reason }) => {
    const onStart = vi.fn()
    render(
      <PdfTranslationControls
        executor={executor}
        ready={ready}
        hasTranslatableText={hasTranslatableText}
        state={idle}
        onStart={onStart}
        onCancel={vi.fn()}
        onNewTranslation={vi.fn()}
      />
    )
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Translate document' }).disabled
    ).toBe(true)
    const hint = screen.getByRole('group', { name: reason })
    fireEvent.focus(hint)
    expect((await screen.findByRole('tooltip')).textContent).toBe(reason)
    fireEvent.keyDown(hint, { key: 'Enter' })
    expect(onStart).not.toHaveBeenCalled()
  }
)

it('explains an unselected API model on hover and retains the same button when selection enables it', async () => {
  useSettingsStore.setState({ providers: [apiProvider] })
  const onStart = vi.fn()
  render(
    <PdfTranslationControls
      executor={apiExecutor}
      ready
      hasTranslatableText
      state={idle}
      onStart={onStart}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Direct API' }))
  const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Translate document' })
  const hint = screen.getByRole('group', { name: 'Select a model to continue.' })
  fireEvent.pointerMove(hint, { pointerType: 'mouse' })
  expect((await screen.findByRole('tooltip')).textContent).toBe('Select a model to continue.')
  fireEvent.pointerLeave(hint, { pointerType: 'mouse' })
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('option', { name: 'first-model · API provider' }))
  expect(start).toBe(screen.getByRole('button', { name: 'Translate document' }))
  expect(start.disabled).toBe(false)
  expect(screen.queryByRole('group', { name: 'Select a model to continue.' })).toBeNull()
})

it('explains disabled new translation actions when API model availability changes', async () => {
  useSettingsStore.setState({ providers: [apiProvider] })
  const onNewTranslation = vi.fn()
  render(
    <PdfTranslationControls
      executor={apiExecutor}
      ready
      hasTranslatableText
      state={{
        status: 'completed',
        done: 1,
        total: 1,
        options: { targetId: 'api', language: 'Chinese', glossary: [] }
      }}
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={onNewTranslation}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'New translation' }))
  const dialog = within(screen.getByRole('dialog', { name: 'New translation' }))
  const start = dialog.getByRole<HTMLButtonElement>('button', { name: 'Translate document' })
  expect(start.disabled).toBe(true)
  fireEvent.focus(dialog.getByRole('group', { name: 'Select a model to continue.' }))
  expect((await screen.findByRole('tooltip')).textContent).toBe('Select a model to continue.')
  fireEvent.keyDown(dialog.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('option', { name: 'first-model · API provider' }))
  expect(start.disabled).toBe(false)
  act(() => useSettingsStore.setState({ providers: [] }))
  expect(start.disabled).toBe(true)
  fireEvent.focus(
    dialog.getByRole('group', {
      name: 'No available API models. Configure an API provider in Settings.'
    })
  )
  expect((await screen.findByRole('tooltip')).textContent).toBe(
    'No available API models. Configure an API provider in Settings.'
  )
  fireEvent.click(start)
  expect(onNewTranslation).not.toHaveBeenCalled()
  act(() => useSettingsStore.setState({ providers: [apiProvider] }))
  expect(start.disabled).toBe(false)
  fireEvent.click(start)
  expect(onNewTranslation).toHaveBeenCalledOnce()
})

it('installs local translation only on request, forces serial execution, and allows removal', async () => {
  const snapshot = {
    availability: 'notInstalled',
    recommendedRevision: 'qwen3-0.6b-q8',
    downloadBytes: 627000000,
    installedBytes: 0,
    hasFiles: false,
    inUse: false,
    transferredBytes: 0,
    updateAvailable: false
  }
  const api = {
    getSnapshot: vi.fn(async () => snapshot),
    install: vi.fn(async () => ({ ...snapshot, availability: 'ready', hasFiles: true })),
    cancel: vi.fn(),
    remove: vi.fn(async () => snapshot)
  }
  vi.stubGlobal('api', { localModels: api })
  const onStart = vi.fn()
  render(
    <PdfTranslationControls
      executor={{
        ...apiExecutor,
        targets: [...apiExecutor.targets, { id: 'local', label: 'Local model', mode: 'local' }]
      }}
      state={idle}
      ready
      hasTranslatableText
      onStart={onStart}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  expect(api.getSnapshot).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Concurrent translations' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: '4x' }))
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Local model' }))
  await screen.findByRole('button', { name: 'Install' })
  expect(api.getSnapshot).toHaveBeenCalledWith('pdf-translation')
  expect(api.install).not.toHaveBeenCalled()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Translate document' }).disabled
  ).toBe(true)
  expect(
    screen.getByRole('group', { name: 'Install the local translation model before translating.' })
  ).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('combobox', { name: 'Concurrent translations' }).disabled
  ).toBe(true)
  expect(
    screen.getByRole('group', {
      name: 'Local translation runs one paragraph at a time to limit memory use.'
    })
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await screen.findByText('Installed')
  fireEvent.click(screen.getByRole('button', { name: 'Translate document' }))
  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({ targetId: 'local', concurrency: 1 })
  )
  fireEvent.click(screen.getByRole('button', { name: /Translation settings/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith('pdf-translation'))
  expect(api.install).toHaveBeenCalledExactlyOnceWith('pdf-translation')
})

it('shows local download progress with cancellation and download errors with retry', async () => {
  const snapshot = {
    availability: 'installing',
    recommendedRevision: 'qwen3-0.6b-q8',
    downloadBytes: 100,
    installedBytes: 0,
    hasFiles: false,
    inUse: false,
    transferredBytes: 50,
    updateAvailable: false
  }
  const api = {
    getSnapshot: vi.fn(async () => snapshot),
    install: vi.fn(async () => ({ ...snapshot, availability: 'error', error: 'integrity' })),
    cancel: vi.fn(async () => ({ ...snapshot, availability: 'notInstalled' })),
    remove: vi.fn()
  }
  vi.stubGlobal('api', { localModels: api })
  render(
    <PdfTranslationControls
      executor={{
        targets: [{ id: 'local', label: 'Local model', mode: 'local' }],
        translate: vi.fn()
      }}
      state={idle}
      ready
      hasTranslatableText
      onStart={vi.fn()}
      onCancel={vi.fn()}
      onNewTranslation={vi.fn()}
    />
  )
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Translation method' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(screen.getByRole('option', { name: 'Local model' }))
  expect((await screen.findByRole('progressbar')).getAttribute('aria-valuenow')).toBe('50')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }))
  await screen.findByRole('button', { name: 'Install' })
  expect(api.cancel).toHaveBeenCalledWith('pdf-translation')
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await screen.findByText('Model verification failed. Retry to download a complete copy.')
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Translate document' }).disabled
  ).toBe(true)
})
