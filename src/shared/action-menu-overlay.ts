// Only presentation crosses the process boundary. Actions and resource snapshots stay with the owner.
export type NativeActionMenuEntry =
  | { kind: 'separator' }
  | {
      kind: 'action'
      action: string
      label: string
      icon: string
      disabled: boolean
      danger: boolean
      disabledDescription?: string
      submenu?: { label: string; icon: string; group: number }
    }

export type NativeActionMenuRequest = {
  id: string
  pointer: { x: number; y: number }
  entries: NativeActionMenuEntry[]
  align?: 'start' | 'end'
  focusFirst?: boolean
  testId?: string
  contentClassName?: string
  dangerClassName?: string
  header?: string
  label?: string
  sections?: Record<string, string>
  dark: boolean
  compact: boolean
}
export type NativeActionMenuResult = { id: string; action?: string }

export const isNativeActionMenuRequest = (value: unknown): value is NativeActionMenuRequest => {
  if (!value || typeof value !== 'object') return false
  const request = value as NativeActionMenuRequest
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= 16384
  return (
    (request.align === undefined || request.align === 'start' || request.align === 'end') &&
    (request.focusFirst === undefined || typeof request.focusFirst === 'boolean') &&
    text(request.id) &&
    request.id.length > 0 &&
    request.id.length <= 128 &&
    !!request.pointer &&
    Number.isFinite(request.pointer.x) &&
    Number.isFinite(request.pointer.y) &&
    [request.testId, request.contentClassName, request.dangerClassName].every(
      (value) => value === undefined || text(value)
    ) &&
    (request.label === undefined || text(request.label)) &&
    (request.sections === undefined ||
      (request.sections &&
        typeof request.sections === 'object' &&
        Object.values(request.sections).every(text))) &&
    (request.header === undefined || text(request.header)) &&
    typeof request.dark === 'boolean' &&
    typeof request.compact === 'boolean' &&
    Array.isArray(request.entries) &&
    request.entries.length > 0 &&
    request.entries.length <= 200 &&
    request.entries.every(
      (entry) =>
        entry &&
        (entry.kind === 'separator' ||
          (entry.kind === 'action' &&
            text(entry.action) &&
            text(entry.label) &&
            text(entry.icon) &&
            typeof entry.disabled === 'boolean' &&
            typeof entry.danger === 'boolean' &&
            (entry.disabledDescription === undefined || text(entry.disabledDescription)) &&
            (entry.submenu === undefined ||
              (entry.submenu &&
                text(entry.submenu.label) &&
                text(entry.submenu.icon) &&
                Number.isSafeInteger(entry.submenu.group)))))
    )
  )
}
