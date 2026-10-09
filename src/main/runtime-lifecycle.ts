export type RuntimeLifecycle = Readonly<{
  relaunch(): void
  quit(): void
  exit(code: number): void
}>
let lifecycle: RuntimeLifecycle | undefined
export function configureRuntimeLifecycle(value: RuntimeLifecycle): void {
  if (lifecycle) throw new Error('Runtime lifecycle is already configured.')
  lifecycle = value
}
export function runtimeLifecycle(): RuntimeLifecycle {
  if (!lifecycle) throw new Error('Runtime lifecycle must be configured by the host entry.')
  return lifecycle
}
