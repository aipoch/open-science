export const INTERFACE_SCALE_OPTIONS = [0.9, 1, 1.1, 1.25] as const
export type InterfaceScale = (typeof INTERFACE_SCALE_OPTIONS)[number]

export type InterfaceScaleShortcut = 'increase' | 'decrease' | 'reset'

export const INTERFACE_SCALE_SHORTCUT_CHANNEL = 'shortcut:interface-scale'

export const isInterfaceScale = (value: unknown): value is InterfaceScale =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  INTERFACE_SCALE_OPTIONS.some((option) => option === value)

export const resolveInterfaceScaleShortcut = (
  current: InterfaceScale,
  shortcut: InterfaceScaleShortcut
): InterfaceScale => {
  if (shortcut === 'reset') return 1

  const currentIndex = INTERFACE_SCALE_OPTIONS.indexOf(current)
  const nextIndex = currentIndex + (shortcut === 'increase' ? 1 : -1)
  return INTERFACE_SCALE_OPTIONS[
    Math.max(0, Math.min(INTERFACE_SCALE_OPTIONS.length - 1, nextIndex))
  ]
}
