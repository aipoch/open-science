import { Check, Copy } from 'lucide-react'
import { useCallback, useState } from 'react'

import type { AcpPermissionRequest } from '../../../../shared/acp'

type PermissionApprovalControlsProps = {
  requests: AcpPermissionRequest[]
  onRespond: (requestId: string, optionId?: string) => void
}

type PermissionOption = AcpPermissionRequest['options'][number]
type PermissionActionKind = 'always' | 'allow-once' | 'reject' | 'other'

const permissionActionOrder: Record<PermissionActionKind, number> = {
  always: 0,
  'allow-once': 1,
  reject: 2,
  other: 3
}

const permissionActionKindByOptionKind: Record<string, PermissionActionKind> = {
  allow_always: 'always',
  allow_once: 'allow-once',
  reject_always: 'reject',
  reject_once: 'reject'
}

// ACP option kinds are protocol semantics; names stay display-only for unknown options.
const getPermissionActionKind = (option: PermissionOption): PermissionActionKind => {
  const normalizedKind = option.kind.toLowerCase()

  return permissionActionKindByOptionKind[normalizedKind] ?? 'other'
}

const getPermissionActionLabel = (
  option: PermissionOption,
  actionKind: PermissionActionKind
): string => {
  if (actionKind === 'always') return 'Always'
  if (actionKind === 'allow-once') return 'Allow once'
  if (actionKind === 'reject') return 'Reject'

  return option.name
}

const getOrderedPermissionOptions = (options: PermissionOption[]): PermissionOption[] =>
  [...options].sort(
    (leftOption, rightOption) =>
      permissionActionOrder[getPermissionActionKind(leftOption)] -
      permissionActionOrder[getPermissionActionKind(rightOption)]
  )

// Shows the full command being approved. Permission is security-sensitive, so the command must be
// fully readable: newlines are preserved and long lines wrap, with a scroll cap for very long
// commands and a copy button so users can review it verbatim before allowing.
const PermissionCommandBlock = ({ command }: { command: string }): React.JSX.Element => {
  const [copied, setCopied] = useState(false)

  const copyCommand = useCallback(async (): Promise<void> => {
    if (!navigator.clipboard?.writeText) return

    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be unavailable in sandboxed contexts.
    }
  }, [command])

  return (
    <div className="flex min-w-0 items-start gap-2">
      <pre className="max-h-48 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-amber-200 bg-white/70 px-2 py-1 font-mono text-[11px] leading-5 text-amber-900">
        {command}
      </pre>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-[12px] hover:bg-amber-100"
        aria-label={copied ? 'Copied command' : 'Copy command'}
        onClick={() => void copyCommand()}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </div>
  )
}

const PermissionApprovalControls = ({
  requests,
  onRespond
}: PermissionApprovalControlsProps): React.JSX.Element | null => {
  // Serialize prompts: show only the oldest pending request. The rest stay queued in the broker and
  // surface one at a time as each is answered, so parallel tool calls don't stack simultaneous prompts.
  const request = requests[0]

  if (!request) return null

  return (
    <div className="mb-2 w-full max-w-full space-y-2 overflow-hidden rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-900">
      <div className="flex min-w-0 flex-col items-stretch gap-2 overflow-hidden">
        <PermissionCommandBlock command={request.title} />
        <span className="flex flex-wrap items-center justify-end gap-1 w-full overflow-hidden">
          {getOrderedPermissionOptions(request.options).map((option) => {
            const actionKind = getPermissionActionKind(option)
            const actionLabel = getPermissionActionLabel(option, actionKind)

            return (
              <button
                key={option.optionId}
                type="button"
                className="max-w-full break-words rounded-md border border-amber-300 bg-white px-2 py-1 text-[12px] hover:bg-amber-100"
                aria-label={`${actionLabel}: ${request.title}`}
                onClick={() => onRespond(request.requestId, option.optionId)}
              >
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {actionLabel}
                </span>
              </button>
            )
          })}
          <button
            type="button"
            className="max-w-full break-words rounded-md px-2 py-1 text-[12px] hover:bg-amber-100"
            aria-label={`Cancel: ${request.title}`}
            onClick={() => onRespond(request.requestId)}
          >
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">Cancel</span>
          </button>
        </span>
      </div>
    </div>
  )
}

export { PermissionApprovalControls }
