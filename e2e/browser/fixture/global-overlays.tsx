import '@/assets/main.css'
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { ActionToast, ActionToastStack } from '@/components/ActionToast'
import { SessionPersistenceAlert } from '@/components/SessionPersistenceAlert'
import { NotificationErrorBoundary } from '@/components/NotificationErrorBoundary'
import { NotificationBell } from '@/components/NotificationBell'
import { NotificationLiveToast } from '@/components/NotificationLiveToast'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import * as Dialog from '@/components/ui/dialog'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { Popover } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { AnnotationTrigger } from '@/pages/workspace/annotations/AnnotationTrigger'

initI18n('en')
window.api = {
  notifications: { getDesktopAvailability: async () => 'supported' }
} as unknown as Window['api']
useNotificationInboxStore.setState({
  status: 'ready',
  items: [],
  latestSequence: 0,
  refresh: async () => {}
})
const fail = new URLSearchParams(location.search).has('fallback')
export const Broken = (): React.JSX.Element => {
  throw new Error('Synthetic notification failure')
}

export function Fixture(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [actions, setActions] = useState(0)
  const [range, setRange] = useState<Range>()
  const text = useRef<HTMLParagraphElement>(null)
  const layer = Number(new URLSearchParams(location.search).get('layer') ?? 50)
  const selectSource = (): void => {
    const selected = document.createRange()
    selected.selectNodeContents(text.current!)
    setRange(selected)
  }
  const showMessage = (): void => {
    useNotificationInboxStore.setState({
      latestSequence: 1,
      items: [
        {
          id: 'fixture',
          sequence: 1,
          dedupeKey: 'fixture',
          kind: 'task.completed',
          source: 'agent-runtime',
          originId: 'fixture',
          title: 'Task completed',
          summary: 'Background task finished',
          createdAt: Date.now()
        }
      ]
    })
  }
  return (
    <>
      <div inert={open} aria-hidden={open || undefined} className="contents">
        <main className="p-8 max-sm:pt-40">
          <h1>Global background overlays</h1>
          <button onClick={showMessage}>Show message</button>
          <button onClick={selectSource}>Select source</button>
          <NotificationBell />
          <p ref={text} className="mt-12">
            Selected research text
          </p>
          <button onClick={() => setOpen(true)}>Open modal</button>
          <Popover>
            {range && (
              <AnnotationTrigger
                range={range}
                backward={false}
                hidden={false}
                label="Annotate"
                onActivate={() => setActions(actions + 1)}
              />
            )}
          </Popover>
          <output data-testid="actions">{actions}</output>
        </main>
        <ActionToastStack>
          <ActionToast
            title="Background action"
            dismissLabel="Dismiss action"
            actionLabel="Run action"
            onAction={() => setActions(actions + 1)}
            onDismiss={() => {}}
          />
        </ActionToastStack>
        <SessionPersistenceAlert
          title="Storage warning"
          message="Background recovery"
          onRetry={() => setActions(actions + 1)}
        />
        {fail ? (
          <NotificationErrorBoundary surface="toast">
            <Broken />
          </NotificationErrorBoundary>
        ) : (
          <NotificationLiveToast />
        )}
      </div>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay
            className={dialogOverlayClassName}
            style={{ zIndex: layer }}
            data-testid="modal-backdrop"
          />
          <Dialog.Content
            className={dialogPanelClassName('w-96')}
            style={{ zIndex: layer }}
            onInteractOutside={(event) => event.preventDefault()}
          >
            <Dialog.Title>Active modal</Dialog.Title>
            <Dialog.Description>Foreground controls remain usable.</Dialog.Description>
            <Select defaultValue="a">
              <SelectTrigger aria-label="Modal choice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={{ zIndex: layer + 10 }}>
                <SelectItem value="a">First choice</SelectItem>
                <SelectItem value="b">Second choice</SelectItem>
              </SelectContent>
            </Select>
            <Dialog.Close>Close modal</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
