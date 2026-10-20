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
  { epoch: number; resolve(): void; reject(): void; promise: Promise<void> } | undefined
export function waitForDesktopSessionRecovery(epoch: number): Promise<void> {
  if (sessionRecovery?.epoch === epoch) return sessionRecovery.promise
  let resolve!: () => void
  let reject!: () => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = () => no(new Error('Session recovery failed.'))
  })
  sessionRecovery = { epoch, resolve, reject, promise }
  return promise
}
export function completeDesktopSessionRecovery(epoch: number, success: boolean): void {
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
