// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputeAccountDialog } from './ComputeAccountControls'
import { useComputeAccount } from './use-compute-account'
import { ComputeTargetGroup } from './ComputeTargetGroup'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
let root: Root, container: HTMLDivElement
const connected = vi.fn()
const get = vi.fn(),
  select = vi.fn(),
  connect = vi.fn(),
  local = vi.fn(),
  cancel = vi.fn(),
  status = vi.fn(),
  pick = vi.fn()
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
describe.each(['modal', 'hugging-face'] as const)('%s connection environment', (provider) => {
  const name = provider === 'modal' ? 'Modal' : 'Hugging Face'
  const addLabel =
    provider === 'modal' ? 'Add Modal Sandbox target' : 'Add Hugging Face Jobs target'
  function Harness(): React.JSX.Element {
    const account = useComputeAccount(provider, false)
    const [open, setOpen] = useState(true)
    return (
      <>
        <span data-testid="account-state">{account.status?.state}</span>
        <ComputeAccountDialog
          provider={provider}
          account={account}
          open={open}
          onClose={() => setOpen(false)}
          onConnected={() => {
            connected()
            setOpen(false)
          }}
        />
      </>
    )
  }
  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    get.mockResolvedValue({
      selection: { kind: 'managed' },
      revision: 0,
      candidates: [{ interpreterPath: '/custom/python', label: 'Research', version: '3.12' }]
    })
    select.mockResolvedValue({ revision: 1 })
    connect.mockResolvedValue({
      provider: provider,
      state: 'pending',
      source: 'managed',
      runtimeRevision: 0
    })
    cancel.mockResolvedValue({ provider: provider, state: 'disconnected' })
    pick.mockResolvedValue(null)
    status.mockResolvedValue({ provider: provider, state: 'disconnected' })
    Object.assign(window, {
      api: {
        compute: {
          accountStatus: status,
          getComputePythonRuntime: get,
          selectComputePythonRuntime: select,
          connectAccount: connect,
          useLocalAccount: local,
          cancelAccountConnection: cancel
        },
        runtime: { pickInterpreter: pick }
      }
    })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  async function renderDialog(): Promise<void> {
    await act(async () => root.render(<Harness />))
    await waitFor(() =>
      expect((screen.getByLabelText('Python environment') as HTMLButtonElement).disabled).toBe(
        false
      )
    )
  }
  it('keeps an unconfigured Modal cold through load and focus, with Add available', async () => {
    useComputeStore.setState({
      ...createInitialComputeState(),
      isLoaded: false,
      loadHosts: vi.fn()
    })
    await act(async () =>
      root.render(
        <ComputeTargetGroup
          backend={provider === 'modal' ? 'modal' : 'hosted'}
          targets={[]}
          describe={() => ''}
          onNavigate={vi.fn()}
        />
      )
    )
    await act(async () => {
      useComputeStore.setState({ isLoaded: true })
      window.dispatchEvent(new Event('focus'))
    })
    expect(status).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: addLabel }) as HTMLButtonElement).disabled).toBe(
      false
    )
    await act(async () => fireEvent.click(screen.getByRole('button', { name: addLabel })))
    expect(get).toHaveBeenCalledOnce()
    expect(status).not.toHaveBeenCalled()
  })
  it('keeps both sign-in buttons during preparation and retries the same login intent inline', async () => {
    const pending = deferred<unknown>()
    connect.mockReturnValueOnce(pending.promise)
    await renderDialog()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Connect in browser' }))
    )
    expect(screen.getByText(`Preparing ${name}…`)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Connect in browser' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Use local sign-in' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect((screen.getByLabelText('Python environment') as HTMLButtonElement).disabled).toBe(false)
    await act(async () =>
      pending.resolve({ provider: provider, state: 'unavailable', runtimeError: 'install' })
    )
    expect(screen.getByRole('alert').textContent).toContain(`Could not prepare ${name} support.`)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect.mock.calls[1][1].operationId).not.toBe(connect.mock.calls[0][1].operationId)
  })
  it('checks a chosen environment, preserves failed candidates and treats native Browse cancel as no change', async () => {
    select.mockResolvedValueOnce({ revision: 0, runtimeError: 'dependency' })
    await renderDialog()
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Python environment'), {
        target: { value: '/custom/python' }
      })
    )
    expect(select).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ selection: { kind: 'custom', pythonPath: '/custom/python' } })
    )
    expect((screen.getByLabelText('Python environment') as HTMLSelectElement).value).toBe(
      '/custom/python'
    )
    expect(
      (screen.getByRole('button', { name: 'Connect in browser' }) as HTMLButtonElement).disabled
    ).toBe(true)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Browse…' })))
    expect(pick).toHaveBeenCalledOnce()
    expect(select).toHaveBeenCalledOnce()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    expect(select).toHaveBeenCalledTimes(2)
    expect(connect).not.toHaveBeenCalled()
  })
  it('keeps a new environment choice open when cancelling the previous login returns connected', async () => {
    const choosing = deferred<unknown>()
    select.mockReturnValueOnce(choosing.promise)
    cancel.mockResolvedValue({
      provider,
      state: 'connected',
      source: 'managed',
      identity: 'previous-account',
      runtimeRevision: 0
    })
    await renderDialog()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Connect in browser' }))
    )
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Python environment'), {
        target: { value: '/custom/python' }
      })
    )
    expect(cancel).toHaveBeenCalledWith(provider, connect.mock.calls[0][1])
    expect(connected).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByText('Checking environment…')).toBeTruthy()
    await act(async () => choosing.resolve({ revision: 1 }))
    expect(connected).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect((screen.getByLabelText('Python environment') as HTMLSelectElement).value).toBe(
      '/custom/python'
    )
  })
  it('cancels by operation identity and ignores connection completion after close', async () => {
    const pending = deferred<unknown>()
    connect.mockReturnValueOnce(pending.promise)
    await renderDialog()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Connect in browser' }))
    )
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))
    expect(cancel).toHaveBeenCalledWith(provider, connect.mock.calls[0][1])
    await act(async () =>
      pending.resolve({ provider: provider, state: 'connected', source: 'managed' })
    )
    expect(connected).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('explains missing local identity and keeps browser sign-in available', async () => {
    local.mockResolvedValueOnce({ provider: provider, state: 'disconnected', reason: 'missing' })
    await renderDialog()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Use local sign-in' }))
    )
    expect(screen.getByRole('alert').textContent).toContain(
      'No local sign-in found. Connect in browser to sign in.'
    )
    expect(
      (screen.getByRole('button', { name: 'Connect in browser' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it.each(['local', 'managed'] as const)(
    'keeps the account connected after a successful %s sign-in unmounts the dialog',
    async (source) => {
      const completed = {
        provider: provider,
        state: 'connected',
        source,
        identity: 'workspace',
        runtimeRevision: 0
      }
      const login = source === 'local' ? local : connect
      if (source === 'local') local.mockResolvedValueOnce(completed)
      else status.mockResolvedValueOnce(completed)
      cancel.mockResolvedValue(completed)
      await renderDialog()
      const label = source === 'local' ? 'Use local sign-in' : 'Connect in browser'
      await act(async () => fireEvent.click(screen.getByRole('button', { name: label })))
      // Browser completion must advance on the existing timer even without a focus event.
      await waitFor(() => expect(connected).toHaveBeenCalledOnce(), { timeout: 3000 })
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(cancel).toHaveBeenCalledWith(provider, login.mock.calls[0][1])
      expect(screen.getByTestId('account-state').textContent).toBe('connected')
    }
  )
})
