import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Plus } from 'lucide-react'
import { normalizeStrictNetworkRule } from '@aipoch/notebook-network-sandbox/network-address'
import type {
  NotebookNetworkSettings,
  NotebookNetworkMode,
  NotebookStrictWhitelistEntry,
  TrustedPrivateDestination
} from '../../../../shared/notebook-network-settings'
import { normalizeTrustedPrivateDestinations } from '../../../../shared/notebook-network'
import {
  trustedDestinationId,
  requiresNetworkException,
  formatNetworkHostname
} from '../../../../shared/notebook-network-settings'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectStore } from '@/stores/project-store'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'

export type NetworkEditorLeaveState = Readonly<{
  dirty: boolean
  busy: boolean
  cancelPendingMode?: () => void
}>

type Editor = { base: NotebookNetworkSettings; id?: string; original?: TrustedPrivateDestination }

function NetworkAddressDeleteButton({
  hostname,
  address,
  disabled,
  onConfirm,
  revoke = false
}: {
  hostname: string
  address: string
  disabled: boolean
  onConfirm: () => void
  revoke?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const title = revoke ? t('Revoke {{name}}', { name: hostname }) : t('Delete address?')
  const action = revoke ? t('Revoke') : t('Delete')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          disabled={disabled}
          aria-label={revoke ? title : t('Remove {{domain}}', { domain: hostname })}
        >
          {action}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3" aria-label={title}>
        <p className="text-sm font-medium">{title}</p>
        <code className="block break-all text-xs text-muted-foreground">{address}</code>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t('Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={disabled}
            onClick={() => {
              setOpen(false)
              onConfirm()
            }}
          >
            {action}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function NotebookNetworkAccessEditor({
  onLeaveStateChange
}: {
  onLeaveStateChange?: (state: NetworkEditorLeaveState | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const external = useSettingsStore((state) => state.notebookNetwork)
  const save = useSettingsStore((state) => state.setNotebookNetwork)
  const projects = useProjectStore((state) => state.projects)
  const [settings, setSettings] = useState(external)
  const [observed, setObserved] = useState(external)
  const [editor, setEditor] = useState<Editor>()
  const [protocol, setProtocol] = useState<'http' | 'https'>('https')
  const [hostname, setHostname] = useState('')
  const [port, setPort] = useState('443')
  const [group, setGroup] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingMode, setPendingMode] = useState<NotebookNetworkMode>()
  const [modeError, setModeError] = useState('')
  const [switching, setSwitching] = useState(false)
  const modeOptions = useRef<HTMLDivElement>(null)
  const modeFocus = useRef<NotebookNetworkMode | undefined>(undefined)
  const restoreAddressFocus = useRef(false)
  const saving = useRef(false)
  const mounted = useRef(true)
  const hostInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const id = useId()
  const currentMode = settings.mode ?? 'relaxed'
  const selectedMode = pendingMode ?? currentMode
  const strict = currentMode === 'strict'
  const editingExisting = Boolean(editor?.id || editor?.original)
  const editorOpen = Boolean(editor)
  const rules = settings.strictWhitelist ?? []
  const groups = settings.strictWhitelistGroups ?? []
  const manual = (settings.trustedPrivateDestinations ?? []).filter((rule) => !rule.managedGrantId)
  const grants = (settings.destinationGrants ?? []).filter((grant) => grant.revokedAt === undefined)
  const showSearch = strict || manual.length + grants.length > 10
  // Rule edits retain their baseline. A different effective mode invalidates all local intent.
  if (external !== observed && !busy) {
    const modeChanged = (external.mode ?? 'relaxed') !== (observed.mode ?? 'relaxed')
    if (!editor || modeChanged) {
      setObserved(external)
      setSettings(external)
    }
    if (modeChanged) {
      setPendingMode(undefined)
      setModeError('')
      setEditor(undefined)
      setError('')
    }
  }
  if (!showSearch && search) setSearch('')
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      onLeaveStateChange?.(null)
    }
  }, [onLeaveStateChange])
  useEffect(() => {
    if (editorOpen) hostInput.current?.focus()
  }, [editorOpen])
  useEffect(() => {
    if (busy || editor) return
    if (modeFocus.current) {
      modeOptions.current
        ?.querySelector<HTMLButtonElement>(`[data-mode="${modeFocus.current}"]`)
        ?.focus()
      modeFocus.current = undefined
    } else if (restoreAddressFocus.current) addButton.current?.focus()
    restoreAddressFocus.current = false
  }, [busy, editor])
  const close = (): void => {
    if (saving.current) return
    restoreAddressFocus.current = true
    setEditor(undefined)
    setError('')
  }
  const commit = useCallback(
    async (
      next: NotebookNetworkSettings,
      base: NotebookNetworkSettings,
      revoke?: readonly string[],
      changingMode = false
    ): Promise<void> => {
      if (saving.current) return
      saving.current = true
      setBusy(true)
      setSwitching(changingMode)
      if (changingMode) setModeError('')
      else setError('')
      try {
        const result = await save(
          next,
          base.allowedDomains,
          base.trustedPrivateDestinations ?? [],
          revoke,
          base
        )
        if (!mounted.current) return
        setSettings(result)
        // Close the draft before adopting another window's merged mode or rules.
        setEditor(undefined)
        if (changingMode || (result.mode ?? 'relaxed') !== (next.mode ?? 'relaxed')) {
          setPendingMode(undefined)
          setModeError('')
          setSearch('')
          setError('')
          modeFocus.current = result.mode ?? 'relaxed'
        } else restoreAddressFocus.current = true
      } catch {
        if (mounted.current) {
          if (changingMode) setModeError(t('Could not switch network mode. Try again.'))
          else setError(t('Could not save network rules. Reopen this page and try again.'))
        }
      } finally {
        saving.current = false
        if (mounted.current) {
          setBusy(false)
          setSwitching(false)
        }
      }
    },
    [save, t]
  )
  const cancelModeChange = useCallback((): void => {
    if (saving.current) return
    setPendingMode(undefined)
    setModeError('')
    modeOptions.current?.querySelector<HTMLButtonElement>(`[data-mode="${currentMode}"]`)?.focus()
  }, [currentMode])
  useEffect(() => {
    onLeaveStateChange?.({
      dirty: Boolean(editor),
      busy,
      ...(pendingMode ? { cancelPendingMode: cancelModeChange } : {})
    })
  }, [editor, busy, pendingMode, cancelModeChange, onLeaveStateChange])
  const selectMode = (mode: NotebookNetworkMode): void => {
    if (saving.current) return
    if (mode === currentMode) cancelModeChange()
    else {
      setPendingMode(mode)
      setModeError('')
    }
  }
  const confirmModeChange = (): void => {
    if (!pendingMode || saving.current) return
    // Read the latest authoritative rules, never the address editor's unsaved draft.
    const base = useSettingsStore.getState().notebookNetwork
    if ((base.mode ?? 'relaxed') !== currentMode) {
      cancelModeChange()
      return
    }
    void commit({ ...base, mode: pendingMode }, base, undefined, true)
  }
  const removeStrictRule = (ruleId: string): void => {
    void commit(
      { ...settings, strictWhitelist: rules.filter((item) => item.id !== ruleId) },
      settings
    )
  }
  const open = (
    rule?: NotebookStrictWhitelistEntry,
    original?: TrustedPrivateDestination
  ): void => {
    setProtocol(rule?.protocol ?? original?.protocol ?? (strict ? 'https' : 'http'))
    setHostname(rule?.hostnamePattern ?? original?.hostname ?? '')
    setPort(String(rule?.port ?? original?.port ?? (strict ? 443 : 80)))
    setGroup(rule?.groupId ?? '')
    setNewGroup('')
    setError('')
    setEditor({ base: settings, id: rule?.id, original })
  }
  const confirm = (): void => {
    if (!editor || busy) return
    const target = normalizeStrictNetworkRule({
      protocol,
      hostnamePattern: hostname,
      port: /^\d+$/.test(port) ? Number(port) : 0
    })
    if (!target || (!strict && target.hostnamePattern.startsWith('*.'))) {
      setError(t('Enter a valid hostname or IP and a port from 1 to 65535.'))
      return
    }
    if (!strict && !requiresNetworkException(target.hostnamePattern, protocol)) {
      setError(t('HTTPS domains already work without an exception. Use HTTP or an IP address.'))
      return
    }
    const base = editor.base
    const persist = (next: NotebookNetworkSettings): void => {
      if (JSON.stringify(next) === JSON.stringify(base)) {
        setError('')
        close()
        return
      }
      void commit(next, base)
    }
    if (strict) {
      let groupId = group
      let groups = [...(base.strictWhitelistGroups ?? [])]
      if (group === '__new__') {
        const name = newGroup.trim()
        if (!name) {
          setError(t('Enter a group name.'))
          return
        }
        const existing = groups.find((item) => item.name.toLowerCase() === name.toLowerCase())
        groupId = existing?.id ?? crypto.randomUUID()
        if (!existing) groups = [...groups, { id: groupId, name }]
      }
      const remaining = (base.strictWhitelist ?? []).filter((rule) => rule.id !== editor.id)
      if (
        remaining.some(
          (rule) =>
            rule.protocol === protocol &&
            rule.hostnamePattern === target.hostnamePattern &&
            rule.port === target.port
        )
      ) {
        setError(t('This address is already in the list.'))
        return
      }
      const rule: NotebookStrictWhitelistEntry = {
        ...target,
        id: editor.id ?? crypto.randomUUID(),
        origin: base.strictWhitelist?.find((row) => row.id === editor.id)?.origin ?? 'manual',
        ...(groupId ? { groupId } : {})
      }
      persist({
        ...base,
        strictWhitelist: editor.id
          ? (base.strictWhitelist ?? []).map((item) => (item.id === editor.id ? rule : item))
          : [...remaining, rule],
        strictWhitelistGroups: groups
      })
    } else {
      const remaining = (base.trustedPrivateDestinations ?? []).filter(
        (rule) => rule !== editor.original
      )
      if (
        remaining.some(
          (rule) =>
            rule.hostname === target.hostnamePattern &&
            rule.port === target.port &&
            (rule.protocol ?? 'https') === protocol
        )
      ) {
        setError(t('This address is already in the list.'))
        return
      }
      const updated = {
        ...editor.original,
        id: editor.original ? trustedDestinationId(editor.original) : crypto.randomUUID(),
        hostname: target.hostnamePattern,
        port: target.port,
        protocol,
        approvedAddresses: []
      }
      const next = normalizeTrustedPrivateDestinations(
        editor.original
          ? (base.trustedPrivateDestinations ?? []).map((item) =>
              item === editor.original ? updated : item
            )
          : [...remaining, updated]
      )
      persist({ ...base, trustedPrivateDestinations: next })
    }
  }
  const groupLabel = (groupId: string): string => {
    const name = groups.find((item) => item.id === groupId)?.name
    // User-created names are data; only migration defaults are translated.
    switch (name) {
      case 'Package registries and source code':
        return t('Package registries and source code')
      case 'NIH and NCBI':
        return t('NIH and NCBI')
      case 'Genomics and pathways':
        return t('Genomics and pathways')
      case 'Proteomics and structures':
        return t('Proteomics and structures')
      case 'Scientific literature':
        return t('Scientific literature')
      case 'Clinical and translational research':
        return t('Clinical and translational research')
      default:
        return name ?? t('Ungrouped')
    }
  }
  const query = search.trim().toLowerCase()
  const matches = (host: string, name = ''): boolean =>
    `${host} ${name}`.toLowerCase().includes(query)
  const visibleGroups = [...groups.map((item) => item.id), '']
    .map((groupId) => ({
      groupId,
      rows: rules.filter(
        (rule) =>
          (rule.groupId ?? '') === groupId && matches(rule.hostnamePattern, groupLabel(groupId))
      )
    }))
    .filter((item) => item.rows.length)
  const rowClass =
    'flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3 text-sm'
  const tagClass = 'rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground'
  const editorForm = editor ? (
    <form
      id={`${id}-form`}
      className="border-t border-border bg-bg-10 p-4"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        confirm()
      }}
    >
      <fieldset disabled={busy} className="grid grid-cols-[6rem_minmax(0,1fr)_5rem] gap-3">
        <label className="space-y-1 text-xs">
          {t('Network protocol')}
          <Select
            value={protocol}
            disabled={busy}
            onValueChange={(value) => {
              const next = value as 'http' | 'https'
              setProtocol(next)
              if (!editingExisting && (port === '80' || port === '443'))
                setPort(next === 'https' ? '443' : '80')
            }}
          >
            <SelectTrigger aria-label={t('Network protocol')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">{t('HTTP')}</SelectItem>
              <SelectItem value="https">{t('HTTPS')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="min-w-0 space-y-1 text-xs">
          {strict ? t('Hostname, IP or pattern') : t('Hostname')}
          <Input
            ref={hostInput}
            value={hostname}
            aria-invalid={!!error}
            onChange={(event) => setHostname(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs">
          {t('Port')}
          <Input
            inputMode="numeric"
            value={port}
            onChange={(event) => setPort(event.target.value)}
          />
        </label>
        {strict ? (
          <label className="col-span-full space-y-1 text-xs">
            {t('Group')}
            <Select
              value={group || '__ungrouped__'}
              disabled={busy}
              onValueChange={(value) => setGroup(value === '__ungrouped__' ? '' : value)}
            >
              <SelectTrigger aria-label={t('Group')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__ungrouped__">{t('Ungrouped')}</SelectItem>
                {groups.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {groupLabel(item.id)}
                  </SelectItem>
                ))}
                <SelectItem value="__new__">{t('New group…')}</SelectItem>
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {strict && group === '__new__' ? (
          <label className="col-span-full space-y-1 text-xs">
            {t('Group name')}
            <Input value={newGroup} onChange={(event) => setNewGroup(event.target.value)} />
          </label>
        ) : null}
      </fieldset>
      {error ? (
        <ErrorNotice className="mt-3" level="error" role="alert" description={error} />
      ) : null}
      {editingExisting ? (
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>
            {t('Cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t('Saving…') : t('Confirm')}
          </Button>
        </div>
      ) : null}
    </form>
  ) : null
  return (
    <div
      className="space-y-5"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && pendingMode && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          cancelModeChange()
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t('Network access mode')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Applies to Notebooks in all projects.')}
          </p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-3">
          <span className="sr-only" role="status">
            {strict ? t('Current: Strict') : t('Current: Relaxed')}
          </span>
          <div
            ref={modeOptions}
            className="grid min-h-9 w-48 max-w-full grid-cols-2 rounded-lg bg-bg-10 p-0.5 [@media(pointer:coarse)]:min-h-11"
            role="radiogroup"
            aria-label={t('Select a network mode to confirm')}
            aria-describedby={pendingMode ? `${id}-mode-status` : undefined}
          >
            {(['relaxed', 'strict'] as const).map((mode) => (
              <button
                key={mode}
                data-mode={mode}
                type="button"
                role="radio"
                aria-checked={selectedMode === mode}
                tabIndex={selectedMode === mode ? 0 : -1}
                disabled={busy}
                className={`min-w-0 rounded-md px-2 py-1 text-sm font-medium transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 ${selectedMode === mode ? (mode === 'strict' ? 'notebook-network-strict' : 'notebook-network-relaxed') : ''} ${pendingMode === mode ? 'border border-dashed' : 'border border-transparent!'}`}
                onKeyDown={(event) => {
                  if (
                    ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                      event.key
                    )
                  ) {
                    event.preventDefault()
                    const next =
                      event.key === 'Home'
                        ? 'relaxed'
                        : event.key === 'End'
                          ? 'strict'
                          : mode === 'strict'
                            ? 'relaxed'
                            : 'strict'
                    selectMode(next)
                    modeOptions.current
                      ?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)
                      ?.focus()
                  }
                }}
                onClick={() => selectMode(mode)}
              >
                {mode === 'relaxed' ? t('Relaxed') : t('Strict')}
              </button>
            ))}
          </div>
        </div>
      </div>
      {pendingMode ? (
        <section
          aria-label={t('Confirm network mode change')}
          aria-busy={switching}
          className={`space-y-3 rounded-xl border p-4 ${pendingMode === 'strict' ? 'notebook-network-strict' : 'notebook-network-relaxed'}`}
        >
          <div className="flex flex-wrap items-center gap-3">
            <h4 className="text-sm font-medium">
              {pendingMode === 'strict'
                ? t('Switch to Strict mode?')
                : t('Switch to Relaxed mode?')}
            </h4>
            <span
              id={`${id}-mode-status`}
              role="status"
              className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
            >
              {t('Not yet applied')}
            </span>
          </div>
          <div className="space-y-1 text-sm leading-6">
            <p className="font-medium">
              {pendingMode === 'strict'
                ? t(
                    'Strict mode uses a whitelist. Connections outside it will be blocked without requesting authorization.'
                  )
                : t('Network access will expand.')}
            </p>
            <p className="text-muted-foreground">
              {pendingMode === 'strict'
                ? t('Trusted unsafe networks will no longer allow connections.')
                : t(
                    'HTTPS hostnames will be allowed by default. HTTP and direct IP connections can request authorization, and saved trusted addresses will apply again.'
                  )}
            </p>
          </div>
          {modeError ? <ErrorNotice level="error" role="alert" description={modeError} /> : null}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <p className="text-xs text-muted-foreground">
              {strict ? t('Strict mode is still active.') : t('Relaxed mode is still active.')}
            </p>
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={cancelModeChange}>
                {t('Cancel')}
              </Button>
              <Button type="button" disabled={busy} onClick={confirmModeChange}>
                {switching
                  ? t('Switching…')
                  : pendingMode === 'strict'
                    ? t('Switch to Strict mode')
                    : t('Switch to Relaxed mode')}
              </Button>
            </div>
          </div>
        </section>
      ) : null}
      <details
        key={strict ? 'strict' : 'relaxed'}
        className={`group rounded-xl ${strict ? 'notebook-network-strict' : 'notebook-network-relaxed'}`}
      >
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl p-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <Check className="size-4" aria-hidden="true" />
          {strict ? t('How Strict mode works') : t('How Relaxed mode works')}
          <ChevronRight
            aria-hidden="true"
            className="ml-auto size-4 transition-transform group-open:rotate-90"
          />
        </summary>
        <ul className="list-disc space-y-2 pr-4 pb-4 pl-12 text-sm leading-6 text-muted-foreground">
          {strict ? (
            <>
              <li>
                {t(
                  'Only matching protocol, hostname or IP, and port are allowed. Unlisted destinations are blocked and cannot request authorization.'
                )}
              </li>
              <li>
                {t(
                  'DNS results are not checked. Matching hostnames may resolve to public, private or loopback addresses.'
                )}
              </li>
              <li>
                {t(
                  'A wildcard such as *.example.org matches subdomains, but not example.org itself.'
                )}
              </li>
              <li>
                {t(
                  'Trusted unsafe networks and previous approvals do not bypass the strict whitelist.'
                )}
              </li>
            </>
          ) : (
            <>
              <li>
                {t(
                  'HTTPS domains are allowed without approval, including localhost and private networks. HTTP and direct IP connections require authorization.'
                )}
              </li>
              <li>
                {t(
                  'Trusted addresses allow the saved protocol, hostname or IP, and port without repeated approval. Add them manually or approve an agent request.'
                )}
              </li>
              <li>{t('The strict whitelist is inactive in Relaxed mode.')}</li>
            </>
          )}
          <li>{t('Saving rules resets protected connections and may interrupt transfers.')}</li>
        </ul>
      </details>
      <section
        className="overflow-hidden rounded-xl border border-border bg-card"
        aria-label={strict ? t('Strict whitelist') : t('Trusted unsafe networks')}
      >
        <div className={showSearch ? undefined : 'flex items-end justify-between gap-4'}>
          <div className="min-w-0 flex-1 p-4">
            <h3 className="font-medium">
              {strict ? t('Strict whitelist') : t('Trusted unsafe networks')}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {strict
                ? t('Edit allowed destinations and organize them into groups.')
                : t('Authorize HTTP or direct IP access to an exact protocol, host and port.')}
            </p>
          </div>
          <div
            data-network-editor-actions
            className={`flex items-center justify-end gap-3 ${showSearch ? 'px-4 pb-4' : 'shrink-0 py-4 pr-4'}`}
          >
            {showSearch ? (
              <Input
                className="min-w-0 flex-1"
                value={search}
                disabled={!!editor}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('Search hostname or group…')}
                aria-label={t('Search network addresses')}
              />
            ) : null}
            {editor && !editingExisting ? (
              <Button data-discard-network-draft variant="ghost" disabled={busy} onClick={close}>
                {t('Cancel')}
              </Button>
            ) : null}
            <Button
              ref={addButton}
              type={editor && !editingExisting ? 'submit' : 'button'}
              form={editor && !editingExisting ? `${id}-form` : undefined}
              disabled={busy || editingExisting}
              className="shrink-0"
              onClick={
                editor && !editingExisting
                  ? undefined
                  : (event) => {
                      event.preventDefault()
                      open()
                    }
              }
            >
              {editor && !editingExisting ? (
                busy ? (
                  t('Saving…')
                ) : (
                  t('Confirm')
                )
              ) : (
                <>
                  <Plus className="size-4" aria-hidden="true" />
                  {strict ? t('Add rule') : t('Add address')}
                </>
              )}
            </Button>
          </div>
        </div>
        {editor && !editingExisting ? editorForm : null}
        {strict ? (
          visibleGroups.map(({ groupId, rows }) => (
            <details key={groupId} className="group" open={query ? true : undefined}>
              <summary className="flex cursor-pointer items-center justify-between border-t border-border px-4 py-3 text-sm font-medium">
                <span className="flex min-w-0 items-center gap-2">
                  <ChevronRight
                    className="size-4 shrink-0 transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  />
                  {groupLabel(groupId)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('{{count}} rules', { count: rows.length, defaultValue_one: '{{count}} rule' })}
                </span>
              </summary>
              {rows.map((rule) => (
                <div key={rule.id}>
                  {editor?.id === rule.id ? (
                    editorForm
                  ) : (
                    <div className={rowClass}>
                      <code
                        className="min-w-0 break-all text-xs"
                        title={`${rule.protocol}://${rule.hostnamePattern}:${rule.port}`}
                      >
                        {rule.protocol}://{rule.hostnamePattern}:{rule.port}
                      </code>
                      <span className={`${tagClass} mr-auto`}>
                        {rule.origin === 'builtin' ? t('Built-in') : t('Manual')}
                      </span>
                      <Button
                        variant="ghost"
                        disabled={busy || !!editor}
                        onClick={() => open(rule)}
                      >
                        {t('Edit')}
                      </Button>
                      <NetworkAddressDeleteButton
                        hostname={rule.hostnamePattern}
                        address={`${rule.protocol}://${rule.hostnamePattern}:${rule.port}`}
                        disabled={busy || !!editor}
                        onConfirm={() => removeStrictRule(rule.id)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </details>
          ))
        ) : (
          <>
            {manual
              .filter((rule) => matches(rule.hostname))
              .map((rule) => (
                <div key={trustedDestinationId(rule)}>
                  {editor?.original === rule ? (
                    editorForm
                  ) : (
                    <div className={rowClass}>
                      <code className="min-w-0 break-all text-xs">
                        {(rule.protocol ?? 'https').toUpperCase()}://
                        {formatNetworkHostname(rule.hostname)}:{rule.port}
                      </code>
                      <span className={`${tagClass} mr-auto`}>{t('Manual')}</span>
                      <Button
                        variant="ghost"
                        disabled={busy || !!editor}
                        onClick={() => open(undefined, rule)}
                      >
                        {t('Edit')}
                      </Button>
                      <NetworkAddressDeleteButton
                        hostname={rule.hostname}
                        address={`${rule.protocol ?? 'https'}://${formatNetworkHostname(rule.hostname)}:${rule.port}`}
                        disabled={busy || !!editor}
                        onConfirm={() =>
                          void commit(
                            {
                              ...settings,
                              trustedPrivateDestinations: (
                                settings.trustedPrivateDestinations ?? []
                              ).filter((item) => item !== rule)
                            },
                            settings
                          )
                        }
                      />
                    </div>
                  )}
                </div>
              ))}
            {grants
              .filter((grant) => matches(grant.hostname))
              .map((grant) => (
                <div key={grant.id} className={rowClass}>
                  <div className="min-w-0 flex-1">
                    <code className="break-all text-xs">
                      {(grant.protocol ?? 'https').toUpperCase()}://
                      {formatNetworkHostname(grant.hostname)}:{grant.port}
                    </code>
                    <span className={`${tagClass} ml-2 inline-block`}>{t('Agent request')}</span>
                    <p className="text-xs text-muted-foreground">
                      {grant.scope === 'global'
                        ? t('All projects')
                        : t('Project: {{project}}', {
                            project:
                              projects.find((project) => project.id === grant.projectId)?.name ??
                              grant.projectId
                          })}
                    </p>
                  </div>
                  <NetworkAddressDeleteButton
                    revoke
                    hostname={grant.hostname}
                    address={`${grant.protocol ?? 'https'}://${formatNetworkHostname(grant.hostname)}:${grant.port}`}
                    disabled={busy || !!editor}
                    onConfirm={() => void commit(settings, settings, [grant.id])}
                  />
                </div>
              ))}
          </>
        )}
        {(
          strict
            ? !visibleGroups.length
            : !manual.some((rule) => matches(rule.hostname)) &&
              !grants.some((grant) => matches(grant.hostname))
        ) ? (
          <p className="border-t border-border p-4 text-sm text-muted-foreground">
            {t('No matching addresses.')}
          </p>
        ) : null}
      </section>
      {error && !editor ? <ErrorNotice level="error" role="alert" description={error} /> : null}
    </div>
  )
}
