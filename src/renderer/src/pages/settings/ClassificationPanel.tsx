/* Hallmark · pre-emit critique: P4 H4 E4 S4 R5 V3
 * component: model settings · genre: modern-minimal · theme: project system
 * Shared controls own focus/hover/pressed/disabled; this panel owns loading/error/success.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Pencil,
  PlugZap,
  Info,
  Eye,
  EyeOff,
  LoaderCircle,
  CheckCircle2,
  XCircle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { InlineNotice } from '@/components/ui/inline-notice'
import { ErrorNotice } from '@/components/error-notice'
import {
  SettingsSection,
  SettingsIconAction,
  SettingsListAddAction,
  SettingsFormFooter
} from './SettingsLayout'
import { TypeSafeIcon, ProviderKindIcon } from './provider-icons'
import { ProviderTestResultCard } from './ProviderTestResultCard'
import type { ValidateProviderResult } from '../../../../shared/settings'
import type {
  ClassificationMutation,
  ClassificationAdapter,
  ClassificationBinding,
  ClassificationSnapshot,
  ClassificationServiceView
} from '../../../../shared/classification'

import { classificationModelsForService } from '../../../../shared/classification'
import {
  customProviderRequiresKey,
  getCustomProviderBaseUrlError
} from '../../../../shared/provider-base-url'

export type ClassificationView =
  | { kind: 'classification' }
  | { kind: 'classification-create' }
  | { kind: 'classification-edit'; serviceId: string }

export const ClassificationPanel = ({
  view,
  navigate
}: {
  view: ClassificationView
  navigate: (view: ClassificationView) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ClassificationSnapshot>()
  const [failed, setFailed] = useState<'load' | 'save'>()
  const [validation, setValidation] = useState<ValidateProviderResult>()
  const [pending, setPending] = useState<string>()
  const busy = Boolean(pending)
  const [probe, setProbe] = useState<Record<string, boolean>>({})
  const live = useRef(true)
  const generation = useRef(0)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      generation.current += 1
    }
  }, [])
  const load = (): Promise<void> => {
    const token = ++generation.current
    return window.api.settings.getClassification().then(
      (next) => {
        if (live.current && token === generation.current) {
          setSnapshot(next)
          setFailed(undefined)
        }
      },
      () => {
        if (live.current && token === generation.current) setFailed('load')
      }
    )
  }
  useEffect(() => {
    void load()
  }, [])
  const mutate = async (request: ClassificationMutation): Promise<boolean> => {
    const token = ++generation.current
    setPending(request.kind)
    setFailed(undefined)
    setValidation(undefined)
    setProbe({})
    try {
      const next = await window.api.settings.updateClassification(request)
      if (next.validation && !next.validation.ok) {
        if (live.current && token === generation.current) setValidation(next.validation)
        return false
      }
      if (live.current && token === generation.current) setSnapshot(next)
      return live.current && token === generation.current
    } catch {
      if (live.current && token === generation.current) setFailed('save')
      return false
    } finally {
      if (live.current && token === generation.current) setPending(undefined)
    }
  }
  const test = async (serviceId: string): Promise<void> => {
    if (!snapshot) return
    const token = ++generation.current
    const id = serviceId
    setPending(id)
    setProbe((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    try {
      const result = await window.api.settings.testClassification({
        serviceId,
        revision: snapshot.revision
      })
      if (live.current && token === generation.current)
        setProbe((current) => ({ ...current, [id]: result.ok }))
    } catch {
      if (live.current && token === generation.current)
        setProbe((current) => ({ ...current, [id]: false }))
    } finally {
      if (live.current && token === generation.current) setPending(undefined)
    }
  }
  const editing = view.kind === 'classification-create' || view.kind === 'classification-edit'
  const existing =
    view.kind === 'classification-edit'
      ? snapshot?.services.find((item) => item.id === view.serviceId)
      : undefined
  return (
    <div className={editing ? 'flex h-full min-h-0 flex-col' : 'space-y-5 p-5'}>
      {failed && (
        <ErrorNotice
          inline
          role="alert"
          tone="amber"
          description={
            failed === 'load'
              ? t('Could not load model services. Reload to try again.')
              : t('Could not save changes. Reload settings and try again.')
          }
          primaryButton={{ label: t('Reload'), onClick: () => void load(), disabled: busy }}
        />
      )}
      {!snapshot ? (
        <p role="status" className="text-sm text-muted-foreground">
          {!failed && t('Loading…')}
        </p>
      ) : editing ? (
        view.kind === 'classification-edit' && !existing ? (
          <ErrorNotice inline description={t('This model service has been removed.')} />
        ) : (
          <ClassificationEditor
            key={`${existing?.id ?? 'new'}:${snapshot.revision}`}
            service={existing}
            availableProviders={snapshot.availableProviders}
            busy={busy}
            validation={validation}
            onDraftChange={() => setValidation(undefined)}
            onSave={async (fields) => {
              const saved = await mutate({ ...fields, revision: snapshot.revision })
              if (saved) navigate({ kind: 'classification' })
              return saved
            }}
            onCancel={() => {
              setFailed(undefined)
              navigate({ kind: 'classification' })
            }}
            onRemove={
              existing
                ? async () => {
                    if (
                      await mutate({ kind: 'remove', id: existing.id, revision: snapshot.revision })
                    )
                      navigate({ kind: 'classification' })
                  }
                : undefined
            }
          />
        )
      ) : (
        <>
          <TooltipProvider delayDuration={200}>
            <SettingsSection
              title={t('Feature settings')}
              description={t(
                'Choose relevant skills and connectors before the agent starts working.'
              )}
              action={
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('About classification models')}
                      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Info className="size-4" aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    aria-label={t('About classification models')}
                    className="max-w-xs space-y-3 p-3 text-left leading-5"
                  >
                    <p>
                      {t(
                        'Classification is optional. If the model is unavailable or the result is unclear, the default method continues. Only the current request and capability names and descriptions are sent.'
                      )}
                    </p>
                    <p>
                      {t(
                        'Available for main conversations using Codex Chat Completions or CodeBuddy.'
                      )}
                    </p>
                  </PopoverContent>
                </Popover>
              }
            >
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                <ClassificationBindingRow
                  snapshot={snapshot}
                  busy={busy || Boolean(failed)}
                  pending={pending}
                  onChange={(binding) =>
                    void mutate({ kind: 'bind', revision: snapshot.revision, binding })
                  }
                />
              </div>
            </SettingsSection>
          </TooltipProvider>
          <SettingsSection
            separated
            title={t('Model services')}
            description={t('Connect a classification model for automatic routing.')}
          >
            {snapshot.services.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                <p>{t('No model services added')}</p>
                <p className="mt-1 text-xs">
                  {t('Optional. Skills and connectors work without a classification model.')}
                </p>
              </div>
            ) : (
              <TooltipProvider delayDuration={200}>
                <ul className="space-y-2">
                  {snapshot.services.map((service) => (
                    <li
                      data-slot="settings-list-row"
                      key={service.id}
                      aria-label={service.name}
                      className="min-w-0 rounded-lg border border-border bg-card p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <h4 className="min-w-0 break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                              {service.name}
                            </h4>
                            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {service.adapter === 'openrouter' ? (
                                <ProviderKindIcon
                                  kindKey="official:openrouter"
                                  className="size-3"
                                />
                              ) : (
                                <TypeSafeIcon />
                              )}
                              {service.adapter === 'openrouter'
                                ? t('OpenRouter')
                                : t('TypeSafe AI')}
                            </span>
                            {probe[service.id] !== undefined && (
                              <span
                                role="status"
                                className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                              >
                                {probe[service.id] ? (
                                  <CheckCircle2
                                    className="size-3.5 text-primary"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <XCircle
                                    className="size-3.5 text-destructive"
                                    aria-hidden="true"
                                  />
                                )}
                                {probe[service.id] ? t('Check passed') : t('Model check failed')}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                            {service.maskedKey ? (
                              <div className="font-mono">
                                {t('Key: {{masked}}', { masked: service.maskedKey })}
                              </div>
                            ) : service.needsKey ? (
                              <div className="text-destructive">{t('Key needs re-entry')}</div>
                            ) : null}
                          </div>
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-2">
                          <SettingsIconAction
                            label={pending === service.id ? t('Checking model…') : t('Check model')}
                            icon={pending === service.id ? LoaderCircle : PlugZap}
                            disabled={busy || !service.configured}
                            aria-busy={pending === service.id}
                            className={
                              pending === service.id
                                ? 'border border-border text-foreground [&_svg]:animate-spin motion-reduce:[&_svg]:animate-none'
                                : 'border border-border text-foreground'
                            }
                            onClick={() => void test(service.id)}
                          />
                          <SettingsIconAction
                            label={t('Edit')}
                            icon={Pencil}
                            disabled={busy}
                            className="border border-border text-foreground"
                            onClick={() =>
                              navigate({ kind: 'classification-edit', serviceId: service.id })
                            }
                          />
                        </div>
                      </div>
                      {probe[service.id] === false && (
                        <InlineNotice role="alert" level="error">
                          {t('Check the API key and network connection, then try again.')}
                        </InlineNotice>
                      )}
                    </li>
                  ))}
                </ul>
              </TooltipProvider>
            )}
            <SettingsListAddAction
              disabled={busy}
              onClick={() => navigate({ kind: 'classification-create' })}
            >
              {t('Add service')}
            </SettingsListAddAction>
          </SettingsSection>
        </>
      )}
    </div>
  )
}

const ClassificationBindingRow = ({
  snapshot,
  busy,
  pending,
  onChange
}: {
  snapshot: ClassificationSnapshot
  busy: boolean
  pending?: string
  onChange: (binding: ClassificationBinding | undefined) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const binding = snapshot.capabilitySelection
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <label
        htmlFor="capability-classifier"
        className="min-w-0 flex-1 text-sm font-medium text-foreground"
      >
        {t('Automatic capability selection')}
      </label>
      <Select
        disabled={busy}
        value={binding ? JSON.stringify(binding) : 'default'}
        onValueChange={(value) => onChange(value === 'default' ? undefined : JSON.parse(value))}
      >
        <SelectTrigger
          id="capability-classifier"
          aria-label={t('Automatic capability selection')}
          aria-busy={pending === 'bind'}
          className="w-full sm:w-72"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">{t('Use default method')}</SelectItem>
          {snapshot.services.flatMap((service) =>
            classificationModelsForService(service).map((model) => (
              <SelectItem
                key={`${service.id}:${model.id}`}
                disabled={!service.configured}
                value={JSON.stringify({ serviceId: service.id, modelId: model.id })}
              >
                {service.name} / {model.label}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  )
}

const ClassificationEditor = ({
  service,
  availableProviders,
  busy,
  validation,
  onDraftChange,
  onSave,
  onRemove,
  onCancel
}: {
  service?: ClassificationServiceView
  availableProviders: ClassificationSnapshot['availableProviders']
  busy: boolean
  validation?: ValidateProviderResult
  onDraftChange: () => void
  onSave: (fields: Extract<ClassificationMutation, { kind: 'save' }>) => Promise<boolean>
  onRemove?: () => Promise<void>
  onCancel: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [id] = useState(() => service?.id ?? crypto.randomUUID())
  const [adapter, setAdapter] = useState<ClassificationAdapter>(service?.adapter ?? 'typesafe')
  const [name, setName] = useState(service?.name ?? 'TypeSafe AI')
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? '')
  const [modelId, setModelId] = useState(service?.modelId ?? '')
  const [providerId, setProviderId] = useState(service?.providerId)
  const needsNewKey = !service || Boolean(service.providerId) || Boolean(service.needsKey)
  const [key, setKey] = useState('')
  const [keyVisible, setKeyVisible] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const customEndpointError =
    adapter === 'custom' ? getCustomProviderBaseUrlError(baseUrl) : undefined
  const customKeyRequired = adapter === 'custom' && customProviderRequiresKey(baseUrl)
  const keyRequired = adapter !== 'custom' ? needsNewKey : customKeyRequired && needsNewKey
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onChange={onDraftChange}
      onSubmit={async (event) => {
        event.preventDefault()
        const saved = await onSave({
          kind: 'save',
          revision: 0,
          id,
          adapter,
          name,
          baseUrl: adapter === 'custom' ? baseUrl.trim() : undefined,
          modelId: adapter === 'custom' ? modelId.trim() : undefined,
          providerId,
          apiKey: providerId ? undefined : key.trim() || undefined
        })
        if (saved) setKey('')
      }}
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <div className="space-y-1.5">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor="classifier-provider"
          >
            {t('Provider')}
          </label>
          <Select
            value={adapter}
            disabled={busy || Boolean(service)}
            onValueChange={(value: ClassificationAdapter) => {
              onDraftChange()
              setAdapter(value)
              setName(
                value === 'openrouter' ? 'OpenRouter' : value === 'custom' ? '' : 'TypeSafe AI'
              )
              setProviderId(value === 'openrouter' ? availableProviders[0]?.id : undefined)
              if (value !== 'custom') {
                setBaseUrl('')
                setModelId('')
              }
              setKey('')
            }}
          >
            <SelectTrigger id="classifier-provider" aria-label={t('Provider')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="typesafe">
                <span className="inline-flex items-center gap-2">
                  <TypeSafeIcon />
                  {t('TypeSafe AI')}
                </span>
              </SelectItem>
              <SelectItem value="openrouter">
                <span className="inline-flex items-center gap-2">
                  <ProviderKindIcon kindKey="official:openrouter" className="size-4" />
                  {t('OpenRouter')}
                </span>
              </SelectItem>
              <SelectItem value="custom">
                <span className="inline-flex items-center gap-2">{t('Custom HTTP service')}</span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="classifier-name">
            {t('Service name')}
          </label>
          <Input
            id="classifier-name"
            required
            maxLength={80}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {adapter === 'custom' && (
          <>
            <InlineNotice role="status" level="info">
              <>
                <p>
                  {t(
                    'Protocol: Open-Science Typed Decisions HTTP. The endpoint must accept state and typed questions, then return model, answers, and usage. Native model APIs may need an adaptor or wrapper.'
                  )}
                </p>
                <p className="mt-1">
                  {t(
                    'This is not a Chat Completions endpoint. Use an adaptor for native model APIs.'
                  )}
                </p>
              </>
            </InlineNotice>
            <div className="space-y-1.5">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="classifier-endpoint"
              >
                {t('Endpoint URL')}
              </label>
              <Input
                id="classifier-endpoint"
                type="url"
                required
                value={baseUrl}
                disabled={busy}
                placeholder="http://localhost:8000/classify"
                aria-invalid={Boolean(customEndpointError) || undefined}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              {customEndpointError && baseUrl.trim() ? (
                <p className="text-xs text-destructive" role="alert">
                  {t('Enter a valid secure HTTP endpoint. Remote endpoints must use HTTPS.')}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="classifier-model"
              >
                {t('Model')}
              </label>
              <Input
                id="classifier-model"
                required
                value={modelId}
                disabled={busy}
                placeholder={t('Model ID exposed by the endpoint')}
                onChange={(event) => setModelId(event.target.value)}
              />
            </div>
          </>
        )}
        {adapter === 'openrouter' && (availableProviders.length > 0 || providerId) && (
          <div className="space-y-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="classifier-key-source"
            >
              {t('API key source')}
            </label>
            <Select
              value={providerId ?? 'new'}
              disabled={busy}
              onValueChange={(value) => {
                onDraftChange()
                setProviderId(value === 'new' ? undefined : value)
                setKey('')
              }}
            >
              <SelectTrigger
                id="classifier-key-source"
                aria-label={t('API key source')}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerId &&
                  !availableProviders.some((provider) => provider.id === providerId) && (
                    <SelectItem value={providerId} disabled>
                      {t('Account unavailable')}
                    </SelectItem>
                  )}
                {availableProviders.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                    {provider.maskedKey ? ` · ${provider.maskedKey}` : ''}
                  </SelectItem>
                ))}
                <SelectItem value="new">{t('Use a new API key')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {!providerId && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="classifier-key">
                {t('API key')}
              </label>
              <ExternalTextLink
                href={
                  adapter === 'openrouter'
                    ? 'https://openrouter.ai/workspaces/default/keys'
                    : 'https://console.typesafe.ai'
                }
                className="text-xs"
              >
                {t('Get an API key')}
              </ExternalTextLink>
            </div>
            <div className="relative">
              <Input
                id="classifier-key"
                type={keyVisible ? 'text' : 'password'}
                autoComplete="new-password"
                className="pe-9"
                placeholder={
                  !needsNewKey ? t('Leave blank to keep the saved key') : t('Paste API key')
                }
                required={keyRequired}
                maxLength={8192}
                value={key}
                disabled={busy}
                onChange={(event) => setKey(event.target.value)}
              />
              <button
                type="button"
                aria-label={keyVisible ? t('Hide API key') : t('Show API key')}
                aria-pressed={keyVisible}
                disabled={busy}
                onClick={() => setKeyVisible(!keyVisible)}
                className="absolute inset-y-0 end-0 flex w-9 items-center justify-center rounded-e-lg text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
              >
                {keyVisible ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        )}
        {onRemove && (
          <div className="border-t border-border pt-4">
            {confirmRemove ? (
              <div className="space-y-3">
                <InlineNotice role="alert" level="warning">
                  {service?.providerId
                    ? t(
                        'Removing this service keeps the shared account and key. Capability selection returns to the default method.'
                      )
                    : t(
                        'Removing this service also removes its saved key. Features using this service return to the default method.'
                      )}
                </InlineNotice>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void onRemove()}
                  >
                    {t('Remove')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmRemove(false)}
                  >
                    {t('Cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                {t('Remove service')}
              </Button>
            )}
          </div>
        )}
      </div>
      <SettingsFormFooter data-slot="classification-form-footer">
        {validation && <ProviderTestResultCard result={validation} />}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button
            type="submit"
            disabled={
              busy ||
              !name.trim() ||
              (adapter === 'custom' &&
                (!baseUrl.trim() || Boolean(customEndpointError) || !modelId.trim())) ||
              (providerId
                ? !availableProviders.some((provider) => provider.id === providerId)
                : keyRequired && !key.trim())
            }
            aria-busy={busy}
          >
            {busy && (
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {busy ? t('Saving…') : t('Save')}
          </Button>
        </div>
      </SettingsFormFooter>
    </form>
  )
}
