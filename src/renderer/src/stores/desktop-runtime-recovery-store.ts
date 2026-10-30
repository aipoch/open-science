import { create } from 'zustand'
import type { DesktopRuntimeRecoveryState } from '../../../shared/desktop-runtime-recovery'

export const useDesktopRuntimeRecoveryStore = create<DesktopRuntimeRecoveryState>(() => ({
  phase: 'connected',
  epoch: 0,
  closing: false
}))
export const getDesktopRuntimeEpoch = (): number => useDesktopRuntimeRecoveryStore.getState().epoch
export const desktopRuntimeWritable = (): boolean => {
  const state = useDesktopRuntimeRecoveryStore.getState()
  return state.phase === 'connected'
}
export const assertDesktopRuntimeWrite = (epoch = getDesktopRuntimeEpoch()): void => {
  if (!desktopRuntimeWritable() || epoch !== getDesktopRuntimeEpoch())
    throw new Error(
      'Desktop connection changed. This operation was not submitted; review current state before saving.'
    )
}

let sessionRecovery:
  | { epoch: number; resolve(): void; reject(error?: Error): void; promise: Promise<void> }
  | undefined
export function waitForDesktopSessionRecovery(epoch: number): Promise<void> {
  if (sessionRecovery?.epoch === epoch) return sessionRecovery.promise
  if (sessionRecovery && epoch < sessionRecovery.epoch)
    return Promise.reject(new Error('Session recovery superseded.'))
  sessionRecovery?.reject(new Error('Session recovery superseded.'))
  let resolve!: () => void
  let reject!: (error?: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = (error = new Error('Session recovery failed.')) => no(error)
  })
  // Completion can precede its consumer, including failure. Keep rejection observable to that
  // consumer without leaving superseded waiters pending or producing an unhandled rejection.
  void promise.catch(() => undefined)
  sessionRecovery = { epoch, resolve, reject, promise }
  return promise
}
export function completeDesktopSessionRecovery(epoch: number, success: boolean): void {
  if (sessionRecovery && epoch < sessionRecovery.epoch) return
  void waitForDesktopSessionRecovery(epoch).catch(() => undefined)
  if (success) sessionRecovery!.resolve()
  else sessionRecovery!.reject()
}

const recoveryReaders = new Set<() => Promise<void>>()
export function registerDesktopRecoveryReader(reader: () => Promise<void>): () => void {
  recoveryReaders.add(reader)
  return () => {
    recoveryReaders.delete(reader)
  }
}
export async function refreshDesktopRecoveryReaders(): Promise<void> {
  await Promise.all([...recoveryReaders].map((reader) => reader()))
}
