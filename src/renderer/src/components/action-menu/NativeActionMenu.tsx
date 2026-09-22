import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useTranslation } from 'react-i18next'
import type { NativeActionMenuRequest } from '../../../../shared/action-menu-overlay'
import type { PointerActionMenuProps } from './PointerActionMenu'

// Custom labels may contain badges/shortcuts. Send their text, never executable HTML or callbacks.
const labelText = (label: ReactNode): string => {
  if (typeof label === 'string') return label
  const document = new DOMParser().parseFromString(renderToStaticMarkup(<>{label}</>), 'text/html')
  return document.body.textContent ?? ''
}

export const NativeActionMenu = <ActionId extends string>({
  entries,
  pointer,
  side,
  align,
  focusFirst,
  header,
  testId,
  contentClassName,
  dangerClassName,
  label,
  sections,
  compact = true,
  renderLabel,
  onSelect,
  onClose,
  onRestoreFocus
}: PointerActionMenuProps<ActionId>): null => {
  const { t } = useTranslation()
  const requestId = useRef('')
  const callbacks = useRef({ onSelect, onClose, onRestoreFocus })
  useLayoutEffect(() => {
    callbacks.current = { onSelect, onClose, onRestoreFocus }
  })
  useLayoutEffect(() => {
    const api = window.api.window
    const id = crypto.randomUUID()
    requestId.current = id
    const unsubscribe = api.onActionMenuClosed!((result) => {
      if (result.id !== id) return
      const handler = callbacks.current
      // Restore before executing: an action may open a dialog with its own autofocus.
      handler.onClose()
      handler.onRestoreFocus()
      if (result.action) handler.onSelect(result.action as ActionId)
    })
    return () => {
      unsubscribe()
      api.closeActionMenu!(id)
    }
  }, [])
  useLayoutEffect(() => {
    const api = window.api.window
    const id = requestId.current
    const groups = new Map<object, number>()
    const request: NativeActionMenuRequest = {
      id,
      testId,
      contentClassName,
      dangerClassName,
      label,
      sections,
      pointer,
      side,
      align,
      focusFirst,
      compact,
      ...(header ? { header: labelText(header) } : {}),
      dark: document.documentElement.classList.contains('dark'),
      entries: entries.map((entry) => {
        if (entry.kind === 'separator') return entry
        const Icon = entry.icon
        const label = t(entry.labelKey)
        const submenu = entry.submenu
        if (submenu && !groups.has(submenu)) groups.set(submenu, groups.size)
        const GroupIcon = submenu?.icon
        return {
          kind: 'action',
          action: entry.action,
          label: labelText(renderLabel?.(entry, label) ?? label),
          icon: renderToStaticMarkup(<Icon size={compact ? 14 : 16} />),
          disabled: entry.disabled,
          danger: entry.danger,
          disabledDescription: entry.disabledDescription,
          ...(submenu && GroupIcon
            ? {
                submenu: {
                  group: groups.get(submenu)!,
                  label: t(submenu.labelKey),
                  icon: renderToStaticMarkup(<GroupIcon size={compact ? 14 : 16} />)
                }
              }
            : {})
        }
      })
    }
    api.openActionMenu!(request)
  }, [
    compact,
    entries,
    header,
    label,
    sections,
    pointer,
    side,
    align,
    focusFirst,
    renderLabel,
    t,
    testId,
    contentClassName,
    dangerClassName
  ])
  return null
}
