// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { SpecialistPackageCandidatePreview } from '../../../shared/specialist-package'
import { useSpecialistStore } from './specialist-store'

afterEach(() => vi.restoreAllMocks())

it.each(['append', 'status'])(
  'aborts the transfer while a %s response is pending',
  async (pendingStep) => {
    let rejectPending!: (error: Error) => void
    const pending = new Promise<never>((_, reject) => {
      rejectPending = reject
    })
    const appendTransfer = vi.fn(() =>
      pendingStep === 'append' ? pending : Promise.reject(new Error('Lost append response'))
    )
    const getTransferStatus = vi.fn(() => pending)
    const abortPackageUpload = vi.fn().mockResolvedValue(undefined)
    const previewPackageUpload = vi.fn()
    window.api = {
      specialist: {
        beginPackageUpload: vi.fn(async (request) => ({
          ...request,
          receivedBytes: 0,
          totalBytes: request.size
        })),
        previewPackageUpload,
        abortPackageUpload,
        cancelPackage: vi.fn(),
        installPackage: vi.fn()
      },
      uploads: { appendTransfer, getTransferStatus }
    } as unknown as Window['api']
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement
    ) {
      Object.defineProperty(this, 'files', { value: [new File(['zip bytes'], 'research.zip')] })
      this.dispatchEvent(new Event('change'))
    })
    useSpecialistStore.setState({ integrity: { status: 'ok' }, packagePreview: undefined })
    const selection = useSpecialistStore.getState().selectPackage()
    try {
      await vi.waitFor(() =>
        expect(pendingStep === 'append' ? appendTransfer : getTransferStatus).toHaveBeenCalledOnce()
      )
      await useSpecialistStore.getState().cancelPackage()
      expect(abortPackageUpload).toHaveBeenCalledWith({
        transferId: vi.mocked(window.api.specialist.beginPackageUpload).mock.calls[0][0].transferId
      })
      expect(previewPackageUpload).not.toHaveBeenCalled()
    } finally {
      rejectPending(new Error('Request disconnected'))
      await selection
    }
  }
)

it('rejects an unavailable import before opening the ZIP chooser', async () => {
  window.api = {} as Window['api']
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement
  ) {
    this.dispatchEvent(new Event('cancel'))
  })
  useSpecialistStore.setState({ integrity: { status: 'ok' } })
  await expect(useSpecialistStore.getState().selectPackage()).rejects.toThrow(/unavailable/)
  expect(click).not.toHaveBeenCalled()
})

it('keeps the new ZIP preview when a cancelled upload response arrives late', async () => {
  let rejectFirst!: (error: Error) => void
  const preview = {
    candidateToken: 'second',
    installable: true
  } as SpecialistPackageCandidatePreview
  const previewPackageUpload = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFirst = reject
        })
    )
    .mockResolvedValueOnce(preview)
  window.api = {
    specialist: {
      beginPackageUpload: vi.fn().mockImplementation(async (request) => ({
        ...request,
        receivedBytes: 0,
        totalBytes: 0
      })),
      previewPackageUpload,
      abortPackageUpload: vi.fn().mockResolvedValue(undefined),
      cancelPackage: vi.fn().mockResolvedValue(undefined),
      installPackage: vi.fn()
    },
    uploads: { appendTransfer: vi.fn(), getTransferStatus: vi.fn() }
  } as unknown as Window['api']
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement
  ) {
    Object.defineProperty(this, 'files', { value: [new File([], 'research.zip')] })
    this.dispatchEvent(new Event('change'))
  })
  useSpecialistStore.setState({ integrity: { status: 'ok' }, packagePreview: undefined })
  const first = useSpecialistStore.getState().selectPackage()
  await vi.waitFor(() => expect(previewPackageUpload).toHaveBeenCalledOnce())
  await useSpecialistStore.getState().cancelPackage()
  await useSpecialistStore.getState().selectPackage()
  expect(useSpecialistStore.getState().packagePreview).toEqual(preview)
  rejectFirst(new Error('Old request disconnected'))
  await first
  expect(useSpecialistStore.getState().packagePreview).toEqual(preview)
  expect(useSpecialistStore.getState().packageUploadPercent).toBeUndefined()
})
