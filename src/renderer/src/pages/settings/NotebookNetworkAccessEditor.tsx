import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Plus } from 'lucide-react'
import { normalizeStrictNetworkRule } from '@aipoch/notebook-network-sandbox/network-address'
import type {
  NotebookNetworkSettings,
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
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'
import type { NetworkEditorLeaveState } from './NotebookNetworkDomainsForm'

type Editor = { base: NotebookNetworkSettings; id?: string; original?: TrustedPrivateDestination }
const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'

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
  const [savedMessage, setSavedMessage] = useState(false)
  const saving = useRef(false)
  const closeAfterSave = useRef(false)
  const mounted = useRef(true)
  const hostInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const id = useId()
  const strict = settings.mode === 'strict'
  const editingExisting = Boolean(editor?.id || editor?.original)
  const editorOpen = Boolean(editor)
  const rules = settings.strictWhitelist ?? []
  const groups = settings.strictWhitelistGroups ?? []
  const manual = (settings.trustedPrivateDestinations ?? []).filter((rule) => !rule.managedGrantId)
  const grants = (settings.destinationGrants ?? []).filter((grant) => grant.revokedAt === undefined)
  const showSearch = strict || manual.length + grants.length > 10
  // Retain an edit's baseline until it is confirmed or cancelled.
  if (external !== observed && !editor && !busy) {
    setObserved(external)
    setSettings(external)
  }
  if (!showSearch && search) setSearch('')
  useEffect(() => {
    onLeaveStateChange?.({ dirty: Boolean(editor), busy })
  }, [editor, busy, onLeaveStateChange])
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
  const close = (): void => {
    if (saving.current) {
      closeAfterSave.current = true
      return
    }
    setEditor(undefined)
    setError('')
    addButton.current?.focus()
  }
  const commit = useCallback(
    async (
      next: NotebookNetworkSettings,
      base: NotebookNetworkSettings,
      revoke?: readonly string[],
      keepEditor?: Editor
    ): Promise<void> => {
      if (saving.current) return
      saving.current = true
      setBusy(true)
      setError('')
      setSavedMessage(false)
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
        // A concurrent mode change must never reinterpret the open address editor.
        const retainEditor =
          keepEditor &&
          !closeAfterSave.current &&
          (result.mode ?? 'relaxed') === (keepEditor.base.mode ?? 'relaxed')
        if (retainEditor) {
          const savedRule = result.strictWhitelist?.find((row) => row.id === keepEditor.id)
          setEditor({
            ...keepEditor,
            base: result,
            original: keepEditor.original
              ? result.trustedPrivateDestinations?.find(
                  (row) => trustedDestinationId(row) === trustedDestinationId(keepEditor.original!)
                )
              : undefined
          })
          if (savedRule) {
            setGroup(savedRule.groupId ?? '')
            setNewGroup('')
          }
        } else setEditor(undefined)
        setSavedMessage(true)
        if (!retainEditor) addButton.current?.focus()
      } catch {
        if (mounted.current)
          setError(t('Could not save network rules. Reopen this page and try again.'))
      } finally {
        saving.current = false
        closeAfterSave.current = false
        if (mounted.current) setBusy(false)
      }
    },
    [save, t]
  )
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
    setSavedMessage(false)
    setEditor({ base: settings, id: rule?.id, original })
  }
  const confirm = (
    closeAfter = true,
    changes: { protocol?: 'http' | 'https'; port?: string; group?: string } = {}
  ): void => {
    if (!editor || busy) return
    const nextProtocol = changes.protocol ?? protocol
    const nextPort = changes.port ?? port
    const nextGroup = changes.group ?? group
    const target = normalizeStrictNetworkRule({
      protocol: nextProtocol,
      hostnamePattern: hostname,
      port: /^\d+$/.test(nextPort) ? Number(nextPort) : 0
    })
    if (!target || (!strict && target.hostnamePattern.startsWith('*.'))) {
      setError(t('Enter a valid hostname or IP and a port from 1 to 65535.'))
      return
    }
    if (!strict && !requiresNetworkException(target.hostnamePattern, nextProtocol)) {
      setError(t('HTTPS domains already work without an exception. Use HTTP or an IP address.'))
      return
    }
    const base = editor.base
    const persist = (next: NotebookNetworkSettings): void => {
      if (JSON.stringify(next) === JSON.stringify(base)) {
        setError('')
        if (closeAfter) close()
        return
      }
      void commit(next, base, undefined, closeAfter ? undefined : editor)
    }
    if (strict) {
      let groupId = nextGroup
      let nextGroups = [...(base.strictWhitelistGroups ?? [])]
      if (nextGroup === '__new__') {
        const name = newGroup.trim()
        if (!name) {
          setError(t('Enter a group name.'))
          return
        }
        const existing = nextGroups.find((item) => item.name.toLowerCase() === name.toLowerCase())
        groupId = existing?.id ?? crypto.randomUUID()
        if (!existing) nextGroups = [...nextGroups, { id: groupId, name }]
      }
      const remaining = (base.strictWhitelist ?? []).filter((rule) => rule.id !== editor.id)
      if (
        remaining.some(
          (rule) =>
            rule.protocol === nextProtocol &&
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
        strictWhitelistGroups: nextGroups
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
            (rule.protocol ?? 'https') === nextProtocol
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
        protocol: nextProtocol,
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
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">{t('Network access mode')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('Relaxed is the default.')}</p>
        </div>
        <div
          data-discard-network-draft
          className="relative grid grid-cols-2 rounded-lg border border-border bg-bg-10 p-1"
          role="radiogroup"
          aria-label={t('Network access mode')}
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute bottom-1 top-1 w-[calc(50%-4px)] rounded-md bg-primary/15 transition-transform motion-reduce:transition-none ${strict ? 'translate-x-full' : 'translate-x-0'}`}
          />
          {(['relaxed', 'strict'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={(settings.mode ?? 'relaxed') === mode}
              tabIndex={(settings.mode ?? 'relaxed') === mode ? 0 : -1}
              disabled={busy}
              className="relative rounded-md px-7 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
              onKeyDown={(event) => {
                if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  const next =
                    event.key === 'Home'
                      ? 'relaxed'
                      : event.key === 'End'
                        ? 'strict'
                        : strict
                          ? 'relaxed'
                          : 'strict'
                  setSearch('')
                  void commit({ ...settings, mode: next }, settings)
                  ;(
                    event.currentTarget.parentElement?.querySelectorAll('button')[
                      next === 'strict' ? 1 : 0
                    ] as HTMLButtonElement
                  )?.focus()
                }
              }}
              onClick={() => {
                if (mode !== (settings.mode ?? 'relaxed')) {
                  setSearch('')
                  void commit({ ...settings, mode }, settings)
                }
              }}
            >
              {mode === 'relaxed' ? t('Relaxed') : t('Strict')}
            </button>
          ))}
        </div>
      </div>
      <details
        key={strict ? 'strict' : 'relaxed'}
        className="group rounded-xl border border-primary/20 bg-primary/5 p-4"
      >
        <summary className="flex cursor-pointer list-none items-center gap-3 text-sm font-medium">
          <Check className="size-4 text-primary" aria-hidden="true" />
          {strict ? t('How Strict mode works') : t('How Relaxed mode works')}
          <ChevronRight
            aria-hidden="true"
            className="ml-auto size-4 transition-transform group-open:rotate-90"
          />
        </summary>
        <ul className="mt-3 list-disc space-y-2 pl-8 text-sm leading-6 text-muted-foreground">
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
        <div className="p-4">
          <h3 className="font-medium">
            {strict ? t('Strict whitelist') : t('Trusted unsafe networks')}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {strict
              ? t('Edit allowed destinations and organize them into groups.')
              : t('Authorize HTTP or direct IP access to an exact protocol, host and port.')}
          </p>
        </div>
        <div data-network-editor-actions className="flex items-center justify-end gap-3 px-4 pb-4">
          {showSearch ? (
            <Input
              className="min-w-0 flex-1"
              value={search}
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
            disabled={busy && !editingExisting}
            className="shrink-0"
            onClick={
              editingExisting
                ? close
                : editor
                  ? undefined
                  : (event) => {
                      event.preventDefault()
                      open()
                    }
            }
          >
            {editor ? (
              busy && !editingExisting ? (
                t('Saving…')
              ) : editingExisting ? (
                t('Done')
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
        {editor ? (
          <form
            id={`${id}-form`}
            className="border-t border-border bg-bg-10 p-4"
            onKeyDown={(event) => {
              if (
                editingExisting &&
                event.key === 'Enter' &&
                !event.nativeEvent.isComposing &&
                event.target instanceof HTMLInputElement
              ) {
                event.preventDefault()
                confirm(false)
              }
            }}
            onBlur={(event) => {
              if (!editingExisting || saving.current) return
              // Retain the editor through the following click, even when saving is immediate.
              if (
                event.relatedTarget instanceof HTMLElement &&
                event.relatedTarget.closest('[data-discard-network-draft]')
              )
                return
              if (event.target instanceof HTMLInputElement) confirm(false)
            }}
            onSubmit={(event) => {
              event.preventDefault()
              confirm()
            }}
          >
            <fieldset disabled={busy} className="grid grid-cols-[6rem_minmax(0,1fr)_5rem] gap-3">
              <label className="space-y-1 text-xs">
                {t('Protocol')}
                <select
                  aria-label={t('Protocol')}
                  className={selectClass}
                  value={protocol}
                  onChange={(event) => {
                    const next = event.target.value as 'http' | 'https'
                    setProtocol(next)
                    const nextPort =
                      !editingExisting && (port === '80' || port === '443')
                        ? next === 'https'
                          ? '443'
                          : '80'
                        : port
                    setPort(nextPort)
                    if (editingExisting) confirm(false, { protocol: next, port: nextPort })
                  }}
                >
                  <option value="http">{t('HTTP')}</option>
                  <option value="https">{t('HTTPS')}</option>
                </select>
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
                  <select
                    aria-label={t('Group')}
                    className={selectClass}
                    value={group}
                    onChange={(event) => {
                      const next = event.target.value
                      setGroup(next)
                      if (editingExisting && next !== '__new__') confirm(false, { group: next })
                    }}
                  >
                    <option value="">{t('Ungrouped')}</option>
                    {groups.map((item) => (
                      <option key={item.id} value={item.id}>
                        {groupLabel(item.id)}
                      </option>
                    ))}
                    <option value="__new__">{t('New group…')}</option>
                  </select>
                </label>
              ) : null}
              {strict && group === '__new__' ? (
                <label className="col-span-full space-y-1 text-xs">
                  {t('Group name')}
                  <Input value={newGroup} onChange={(event) => setNewGroup(event.target.value)} />
                </label>
              ) : null}
            </fieldset>
          </form>
        ) : null}
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
                <div key={rule.id} className={rowClass}>
                  <code
                    className="min-w-0 flex-1 break-all"
                    title={`${rule.protocol}://${rule.hostnamePattern}:${rule.port}`}
                  >
                    {rule.protocol}://{rule.hostnamePattern}:{rule.port}
                  </code>
                  <span className={tagClass}>
                    {rule.origin === 'builtin' ? t('Built-in') : t('Manual')}
                  </span>
                  <Button variant="ghost" disabled={busy || !!editor} onClick={() => open(rule)}>
                    {t('Edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy || !!editor}
                    onClick={() => removeStrictRule(rule.id)}
                    aria-label={t('Remove {{domain}}', { domain: rule.hostnamePattern })}
                  >
                    {t('Delete')}
                  </Button>
                </div>
              ))}
            </details>
          ))
        ) : (
          <>
            {manual
              .filter((rule) => matches(rule.hostname))
              .map((rule) => (
                <div key={`${rule.protocol}://${rule.hostname}:${rule.port}`} className={rowClass}>
                  <code className="min-w-0 flex-1 break-all">
                    {(rule.protocol ?? 'https').toUpperCase()}://
                    {formatNetworkHostname(rule.hostname)}:{rule.port}
                  </code>
                  <span className={tagClass}>{t('Manual')}</span>
                  <Button
                    variant="ghost"
                    disabled={busy || !!editor}
                    onClick={() => open(undefined, rule)}
                  >
                    {t('Edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy || !!editor}
                    onClick={() =>
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
                    aria-label={t('Remove {{domain}}', { domain: rule.hostname })}
                  >
                    {t('Delete')}
                  </Button>
                </div>
              ))}
            {grants
              .filter((grant) => matches(grant.hostname))
              .map((grant) => (
                <div key={grant.id} className={rowClass}>
                  <div className="min-w-0 flex-1">
                    <code className="break-all">
                      {(grant.protocol ?? 'https').toUpperCase()}://
                      {formatNetworkHostname(grant.hostname)}:{grant.port}
                    </code>
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
                  <span className={tagClass}>{t('Agent request')}</span>
                  <Button
                    variant="ghost"
                    disabled={busy || !!editor}
                    onClick={() => void commit(settings, settings, [grant.id])}
                  >
                    {t('Revoke')}
                  </Button>
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
      {error ? (
        <ErrorNotice level="error" role="alert" description={error} />
      ) : savedMessage ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t('Network rules saved.')}
        </p>
      ) : null}
    </div>
  )
}
