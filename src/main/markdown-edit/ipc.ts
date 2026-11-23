import { callerLeaseForEvent } from '../caller-lifecycle'
import { ipcMainHandle } from '../ipc-handler-registry'
import { markdownEditStore } from './store'

export function registerMarkdownEditIpc(): void {
  const releases = new Map<string, { owner: number; release(): void }>()
  ipcMainHandle('markdown-edits:open', (event, projectId: string, markdown: string) => {
    const lease = callerLeaseForEvent(event)
    const owner = event.sender.id
    const handle = markdownEditStore.open(owner, projectId, markdown)
    const release = (): void => {
      unsubscribe()
      clearTimeout(expiry)
      lease.signal.removeEventListener('abort', release)
      releases.delete(handle)
      markdownEditStore.close(owner, handle)
    }
    const unsubscribe = markdownEditStore.onReady(owner, handle, () => {
      const replacement = markdownEditStore.take(owner, handle)
      try {
        if (replacement !== null && lease.isCurrent()) {
          event.sender.send('markdown-edits:replacement', { handle, markdown: replacement })
        }
      } finally {
        release()
      }
    })
    const expiry = setTimeout(release, 15 * 60_000)
    expiry.unref()
    releases.set(handle, { owner, release })
    lease.signal.addEventListener('abort', release, { once: true })
    return handle
  })
  ipcMainHandle('markdown-edits:close', (event, handle: string) => {
    const record = releases.get(handle)
    if (record?.owner === event.sender.id) record.release()
  })
}
