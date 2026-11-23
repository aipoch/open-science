/* eslint-disable react-refresh/only-export-components -- Private bridge context and its hooks share one module. */
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'

type Host = { id: string; scope: string; element: HTMLDivElement; enabled: boolean }
type Editor = { id: string; scope: string }
type Bridge = {
  host?: Host
  editors: readonly Editor[]
  registerHost(host: Host): () => void
  registerEditor(editor: Editor): () => void
}
const Context = createContext<Bridge | undefined>(undefined)

export function ImageComposerBridgeProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const [host, setHost] = useState<Host>()
  const [editors, setEditors] = useState<readonly Editor[]>([])
  const registerHost = useCallback((value: Host) => {
    setHost(value)
    return () => setHost((current) => (current === value ? undefined : current))
  }, [])
  const registerEditor = useCallback((value: Editor) => {
    setEditors((current) => [...current.filter(({ id }) => id !== value.id), value])
    return () => setEditors((current) => current.filter((entry) => entry !== value))
  }, [])
  const value = useMemo(
    () => ({ host, editors, registerHost, registerEditor }),
    [host, editors, registerHost, registerEditor]
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

// The normal conversation editor stays mounted while hidden, preserving its draft, caret,
// attachments and undo history. Permission/authentication surfaces retain priority over this slot.
export function useImageComposerHost(
  scope: string | undefined,
  enabled: boolean
): {
  active: boolean
  attachHost: (element: HTMLDivElement | null) => void
} {
  const bridge = useContext(Context)
  const id = useId()
  const [element, ref] = useState<HTMLDivElement | null>(null)
  const registerHost = bridge?.registerHost
  useLayoutEffect(() => {
    if (scope && element && registerHost) return registerHost({ id, scope, element, enabled })
    return undefined
  }, [id, scope, element, enabled, registerHost])
  const active = Boolean(
    enabled &&
    scope &&
    bridge?.host?.id === id &&
    bridge.editors.some((entry) => entry.scope === scope)
  )
  return { active, attachHost: ref }
}

export function useImageComposerTarget(
  scope: string,
  viewport: HTMLElement | null,
  localComposer = false
): HTMLDivElement | null | undefined {
  const bridge = useContext(Context)
  const id = useId()
  const [placement, setPlacement] = useState<'conversation' | 'local'>()
  useLayoutEffect(() => {
    if (viewport)
      // DOM ancestry is only available after the viewport mounts.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlacement(
        localComposer || viewport.closest('[role="dialog"], [role="alertdialog"]')
          ? 'local'
          : 'conversation'
      )
  }, [viewport, localComposer])
  const registerEditor = bridge?.registerEditor
  useLayoutEffect(() => {
    if (placement === 'conversation' && registerEditor) return registerEditor({ id, scope })
    return undefined
  }, [id, scope, placement, registerEditor])
  // undefined renders locally. null defers the first mount until its destination is known.
  if (!bridge || localComposer || placement === 'local') return undefined
  if (!placement) return null
  const host = bridge.host
  if (!host?.enabled || host.scope !== scope) return undefined
  if (!bridge.editors.some((entry) => entry.id === id && entry.scope === scope)) return null
  const owner = bridge.editors.findLast((entry) => entry.scope === scope)
  return owner?.id === id ? host.element : undefined
}
