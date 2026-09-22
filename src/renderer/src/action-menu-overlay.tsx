import { useEffect, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import type {
  NativeActionMenuRequest,
  NativeActionMenuResult
} from '../../shared/action-menu-overlay'
import { DomPointerActionMenu } from './components/action-menu/PointerActionMenu'
import type { ResolvedActionMenuEntry } from './components/action-menu/action-menu-model'
import './assets/main.css'
import './assets/action-menu-overlay.css'

// Labels are already translated by the owner. No application stores or broad preload are loaded here.
void i18next
  .use(initReactI18next)
  .init({ lng: 'en', resources: {}, initAsync: false, keySeparator: false, nsSeparator: false })
const api = (
  window as unknown as {
    actionMenu: {
      onShow: (listener: (request: NativeActionMenuRequest) => void) => () => void
      onHide: (listener: (id: string) => void) => () => void
      mounted: () => void
      ready: (id: string) => void
      result: (result: NativeActionMenuResult) => void
    }
  }
).actionMenu
const icon = (svg: string): LucideIcon =>
  ((props: { className?: string }) => (
    <img className={props.className} alt="" src={`data:image/svg+xml,${encodeURIComponent(svg)}`} />
  )) as LucideIcon

export const Menu = ({ request }: { request: NativeActionMenuRequest }): React.JSX.Element => {
  const groups = new Map<number, { labelKey: string; icon: LucideIcon }>()
  const entries: ResolvedActionMenuEntry[] = request.entries.map((entry) => {
    if (entry.kind === 'separator') return entry
    const group = entry.submenu
    if (group && !groups.has(group.group))
      groups.set(group.group, { labelKey: group.label, icon: icon(group.icon) })
    return {
      ...entry,
      labelKey: entry.label,
      icon: icon(entry.icon),
      submenu: group ? groups.get(group.group) : undefined
    }
  })
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', request.dark)
    api.ready(request.id)
  }, [request])
  return (
    <DomPointerActionMenu
      entries={entries}
      label={request.label}
      sections={request.sections}
      pointer={request.pointer}
      side={request.side}
      align={request.align}
      focusFirst={request.focusFirst}
      compact={request.compact}
      header={
        request.header ? (
          <div className="max-w-80 whitespace-pre-wrap break-words px-2 py-1 text-xs">
            {request.header}
          </div>
        ) : undefined
      }
      testId={request.testId ?? 'native-action-menu'}
      contentClassName={request.contentClassName}
      dangerClassName={request.dangerClassName}
      onSelect={(action) => api.result({ id: request.id, action })}
      onClose={() => api.result({ id: request.id })}
      onRestoreFocus={() => {}}
    />
  )
}
export const App = (): React.JSX.Element | null => {
  const [request, setRequest] = useState<NativeActionMenuRequest>()
  useEffect(() => {
    const show = api.onShow(setRequest)
    const hide = api.onHide((id) =>
      setRequest((current) => (current?.id === id ? undefined : current))
    )
    api.mounted()
    return () => {
      show()
      hide()
    }
  }, [])
  return request ? <Menu key={request.id} request={request} /> : null
}
createRoot(document.getElementById('root')!).render(<App />)
