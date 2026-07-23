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
  actionKind: PermissionActionKind,
  hasMultipleOptionsForAction: boolean
): string => {
  const canonicalLabel =
    actionKind === 'always'
      ? 'Always'
      : actionKind === 'allow-once'
        ? 'Allow once'
        : actionKind === 'reject'
          ? 'Reject'
          : undefined

  if (!canonicalLabel) return option.name

  // Provider names distinguish multiple scopes, but never replace the protocol-derived semantic
  // label: an untrusted allow_always name such as "Reject" must still render as an Always action.
  const providerLabel = option.name.trim()
  if (
    hasMultipleOptionsForAction &&
    providerLabel &&
    providerLabel.toLowerCase() !== canonicalLabel.toLowerCase()
  ) {
    return `${canonicalLabel} - ${providerLabel}`
  }

  return canonicalLabel
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

const getPermissionRiskLabel = (request: AcpPermissionRequest): string => {
  if (request.providerToolName === 'notebook_execute') return 'Notebook execution'
  if (request.isMcp) return 'MCP tool access'

  switch (request.toolKind) {
    case 'execute':
      return 'Command execution'
    case 'edit':
    case 'delete':
    case 'move':
      return 'File change'
    case 'fetch':
      return 'Network access'
    case 'read':
    case 'search':
      return 'File access'
    default:
      return 'Tool access'
  }
}

const getNotebookCode = (request: AcpPermissionRequest): string | undefined => {
  if (request.providerToolName !== 'notebook_execute') return undefined
  if (!request.rawInput || typeof request.rawInput !== 'object') return undefined

  const code = (request.rawInput as Record<string, unknown>).code

  return typeof code === 'string' && code.trim() ? code : undefined
}

const PermissionApprovalControls = ({
  requests,
  onRespond
}: PermissionApprovalControlsProps): React.JSX.Element | null => {
  // Serialize prompts: show only the oldest pending request. The rest stay queued in the broker and
  // surface one at a time as each is answered, so parallel tool calls don't stack simultaneous prompts.
  const request = requests[0]

  if (!request) return null

  const notebookCode = getNotebookCode(request)
  const actionCounts = request.options.reduce<Map<PermissionActionKind, number>>(
    (counts, option) => {
      const actionKind = getPermissionActionKind(option)
      counts.set(actionKind, (counts.get(actionKind) ?? 0) + 1)
      return counts
    },
    new Map()
  )

  return (
    <div className="mb-2 w-full max-w-full space-y-2 overflow-hidden rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-900">
      <div className="flex min-w-0 flex-col items-stretch gap-2 overflow-hidden">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">{getPermissionRiskLabel(request)}</span>
          {request.toolLocations?.length ? (
            <span className="min-w-0 truncate text-[11px] text-amber-800">
              {request.toolLocations.map((location) => location.path).join(', ')}
            </span>
          ) : null}
        </div>
        <PermissionCommandBlock command={request.title} />
        {notebookCode ? <PermissionCommandBlock command={notebookCode} /> : null}
        <span className="flex flex-wrap items-center justify-end gap-1 w-full overflow-hidden">
          {getOrderedPermissionOptions(request.options).map((option) => {
            const actionKind = getPermissionActionKind(option)
            const actionLabel = getPermissionActionLabel(
              option,
              actionKind,
              (actionCounts.get(actionKind) ?? 0) > 1
            )

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
