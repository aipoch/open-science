import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'

type WorkspaceAgentLoadingRowProps = {
  sessionId: string
}

const assistantMessageSurfaceClassName =
  'relative w-full max-w-[56rem] text-sm leading-relaxed text-text-000 md:text-[15px]'

// Shows an accessible interim assistant row before the first streamed text chunk arrives.
const AgentLoadingIndicator = (): React.JSX.Element => (
  <div className="flex min-h-5 items-center gap-1.5" role="status" aria-live="polite">
    <span className="sr-only">Agent is responding</span>
    <span
      className="size-1.5 animate-pulse rounded-full bg-text-300 opacity-80"
      aria-hidden="true"
    />
    <span
      className="size-1.5 animate-pulse rounded-full bg-text-300 opacity-80 [animation-delay:150ms]"
      aria-hidden="true"
    />
    <span
      className="size-1.5 animate-pulse rounded-full bg-text-300 opacity-80 [animation-delay:300ms]"
      aria-hidden="true"
    />
  </div>
)

// Places the loading indicator in the same transcript geometry as assistant messages.
const WorkspaceAgentLoadingRow = ({
  sessionId
}: WorkspaceAgentLoadingRowProps): React.JSX.Element => (
  <MessageScrollerItem
    key={`${sessionId}-agent-loading`}
    messageId={`${sessionId}-agent-loading`}
    className="min-w-0"
  >
    <div className="px-4 pb-1 pt-5 md:px-6">
      <div className={cn(assistantMessageSurfaceClassName, 'rounded-2xl bg-bg-200 px-3 py-2')}>
        <AgentLoadingIndicator />
      </div>
    </div>
  </MessageScrollerItem>
)

export { WorkspaceAgentLoadingRow }
