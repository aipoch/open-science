import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineNotice } from '@/components/ui/inline-notice'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ErrorNotice } from '@/components/error-notice'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { ImageServicesView } from '../../lib/settings-navigation'
import {
  IMAGE_MODEL_PRESET_ADAPTERS,
  IMAGE_VENDOR_CATALOG,
  isQwenWorkspaceBaseUrl,
  type ImageVendorId,
  type ImageAdapterKind,
  type ImageModelPresetId,
  type ImageModelSettingsSnapshot,
  type ImageServiceConfiguration,
  type ImageServiceModel
} from '../../../../shared/image-model-settings'
import {
  customProviderRequiresKey,
  getCustomProviderBaseUrlError
} from '../../../../shared/provider-url-policy'
import {
  SettingsFormFooter,
  SettingsIconAction,
  SettingsListAddAction,
  SettingsSection
} from './SettingsLayout'
import { useImageModelSettings } from './use-image-model-settings'
import { ImageServiceTest } from './ImageServiceTest'
import { ProviderKindIcon } from './provider-icons'

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'

const adapterLabels: Record<ImageAdapterKind, string> = {
  minimax: 'MiniMax',
  'openai-images': 'OpenAI Images',
  'qwen-images': 'Qwen Images',
  seedream: 'Seedream'
}

const defaultPresets: Record<ImageAdapterKind, ImageModelPresetId> = {
  minimax: 'minimax-h3/official',
  'openai-images': 'openai-images/generic',
  'qwen-images': 'qwen/image-3.0',
  seedream: 'seedream/5.5'
}

const presetLabels: Record<ImageModelPresetId, string> = {
  'minimax-h3/official': 'MiniMax H3',
  'minimax-h3/sglang': 'MiniMax H3 · SGLang',
  'openai-images/generic': 'OpenAI Images',
  'openai/gpt-image-2.6': 'GPT Image 2.6',
  'qwen/image-3.0': 'Qwen Image 3.0',
  'seedream/5.5': 'Seedream 5.5'
}

export const ImageModelSelector = ({
  state,
  onManage
}: {
  state: ReturnType<typeof useImageModelSettings>
  onManage: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { snapshot, busy, mutate } = state
  return (
    <div className="space-y-3 py-3">
      <ImageSettingsError state={state} />
      <div className="flex min-w-0 items-center gap-2">
        <Select
          value={snapshot?.imageModel ? JSON.stringify(snapshot.imageModel) : 'none'}
          disabled={busy || !snapshot}
          onValueChange={(value) =>
            void mutate({ kind: 'bind', binding: value === 'none' ? undefined : JSON.parse(value) })
          }
        >
          <SelectTrigger className="min-w-0 flex-1" aria-label={t('Image generation model')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t('Not configured')}</SelectItem>
            {snapshot?.services.flatMap((service) =>
              service.models.map((model) => (
                <SelectItem
                  key={`${service.id}:${model.id}`}
                  disabled={!service.configured}
                  value={JSON.stringify({ serviceId: service.id, modelId: model.id })}
                >
                  <span className="truncate">
                    {service.name} · {model.label ?? model.wireModelId}
                  </span>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={onManage}>
          {t('Image services')}
        </Button>
      </div>
      <ImageSettingsSaved saved={state.saved} />
    </div>
  )
}

const ImageSettingsSaved = ({
  saved
}: {
  saved: ReturnType<typeof useImageModelSettings>['saved']
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  return saved ? (
    <InlineNotice level="success" role="status">
      {saved.appliesNextTurn
        ? t('Saved. New image settings apply from the next turn.')
        : t('Saved')}
    </InlineNotice>
  ) : null
}

const ImageSettingsError = ({
  state
}: {
  state: ReturnType<typeof useImageModelSettings>
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  return state.failed ? (
    <ErrorNotice
      inline
      role="alert"
      tone="amber"
      description={
        state.failed === 'load'
          ? t('Could not load model services. Reload to try again.')
          : t('Could not save changes. Reload settings and try again.')
      }
      primaryButton={{
        label: t('Reload'),
        onClick: () => void state.reload(),
        disabled: state.busy
      }}
    />
  ) : null
}

export const ImageServicesPanel = ({
  view,
  navigate
}: {
  view: ImageServicesView
  navigate: (view: ImageServicesView) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const state = useImageModelSettings()
  const { snapshot, busy, mutate } = state
  const [pendingRemoval, setPendingRemoval] =
    useState<Pick<ImageServiceConfiguration, 'id' | 'name'>>()
  const removal = useRetainedDialogValue(pendingRemoval)
  const removeTrigger = useRef<HTMLButtonElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const existing =
    view.kind === 'image-service-edit'
      ? snapshot?.services.find((service) => service.id === view.serviceId)
      : undefined
  if (!snapshot)
    return (
      <div className="p-5">
        <ImageSettingsError state={state} />
        {!state.failed && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('Loading…')}
          </p>
        )}
      </div>
    )
  if (view.kind !== 'image-services')
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ImageSettingsError state={state} />
        {view.kind === 'image-service-edit' && !existing ? (
          <ErrorNotice inline description={t('This model service has been removed.')} />
        ) : (
          <ImageServiceEditor
            key={existing?.id ?? 'new'}
            service={existing}
            snapshot={snapshot}
            busy={busy}
            onCancel={() => navigate({ kind: 'image-services' })}
            onSave={async (service, apiKey) => {
              if (
                await mutate({
                  kind: 'save',
                  ...service,
                  ...(apiKey !== undefined ? { apiKey } : {})
                })
              )
                navigate({ kind: 'image-services' })
            }}
            onRemove={
              existing
                ? async () => {
                    if (await mutate({ kind: 'remove', id: existing.id }))
                      navigate({ kind: 'image-services' })
                  }
                : undefined
            }
          />
        )}
      </div>
    )
  return (
    <div className="space-y-5 p-5">
      <ImageSettingsError state={state} />
      <ImageSettingsSaved saved={state.saved} />
      <SettingsSection
        title={t('Image services')}
        actionClassName="ml-auto"
        action={
          <Button
            ref={addButton}
            type="button"
            variant="outline"
            size="sm"
            disabled={snapshot.services.length >= 16}
            onClick={() => navigate({ kind: 'image-service-create' })}
          >
            <Plus aria-hidden="true" />
            {t('Add image service')}
          </Button>
        }
      >
        <TooltipProvider delayDuration={200}>
          {snapshot.services.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">{t('No model services added')}</p>
          ) : (
            <ul className="space-y-2">
              {snapshot.services.map((service) => {
                const vendorId =
                  service.vendorId ??
                  snapshot.availableProviders.find((account) => account.id === service.providerId)
                    ?.vendorId
                const models = service.models
                  .map((model) => model.label ?? model.wireModelId)
                  .join(' · ')
                return (
                  <li
                    key={service.id}
                    data-slot="settings-list-row"
                    className="rounded-lg border border-border bg-card p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <ProviderKindIcon
                            kindKey={vendorId ? `official:${vendorId}` : 'custom'}
                          />
                          <span className="truncate text-sm font-medium text-foreground">
                            {service.name}
                          </span>
                          {!service.configured && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t('Not configured')}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground" title={models}>
                          {models}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <SettingsIconAction
                          label={t('Edit {{name}}', { name: service.name })}
                          icon={Pencil}
                          className="border border-border text-foreground"
                          onClick={() =>
                            navigate({ kind: 'image-service-edit', serviceId: service.id })
                          }
                        />
                        <SettingsIconAction
                          label={t('Delete')}
                          icon={Trash2}
                          danger
                          disabled={busy}
                          className="border border-border"
                          onFocus={(event) => {
                            if (!event.currentTarget.matches(':focus-visible'))
                              event.preventDefault()
                          }}
                          onClick={(event) => {
                            removeTrigger.current = event.currentTarget
                            setPendingRemoval({ id: service.id, name: service.name })
                          }}
                        />
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </TooltipProvider>
      </SettingsSection>
      <ConfirmActionDialog
        open={Boolean(pendingRemoval)}
        title={t('Delete {{name}}?', { name: removal?.name ?? '' })}
        description={t('This removes the image service and its model settings.')}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Delete')}
        loading={busy}
        destructive
        onCancel={() => setPendingRemoval(undefined)}
        onConfirm={() => {
          if (pendingRemoval)
            void mutate({ kind: 'remove', id: pendingRemoval.id }).then(() =>
              setPendingRemoval(undefined)
            )
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const button = removeTrigger.current
          ;(button?.isConnected ? button : addButton.current)?.focus()
        }}
      />
    </div>
  )
}

const ImageServiceEditor = ({
  service,
  snapshot,
  busy,
  onSave,
  onCancel,
  onRemove
}: {
  service?: ImageModelSettingsSnapshot['services'][number]
  snapshot: ImageModelSettingsSnapshot
  busy: boolean
  onSave: (service: ImageServiceConfiguration, apiKey?: string) => Promise<void>
  onCancel: () => void
  onRemove?: () => Promise<void>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [id] = useState(() => service?.id ?? crypto.randomUUID())
  const [name, setName] = useState(service?.name ?? '')
  const [vendorId, setVendorId] = useState<ImageVendorId | 'custom'>(
    service?.vendorId ??
      snapshot.availableProviders.find((entry) => entry.id === service?.providerId)?.vendorId ??
      'custom'
  )
  const vendor = IMAGE_VENDOR_CATALOG.find((entry) => entry.id === vendorId)
  const accounts = snapshot.availableProviders.filter((entry) => entry.vendorId === vendorId)
  const [providerId, setProviderId] = useState(service?.providerId)
  const [officialBaseUrl, setOfficialBaseUrl] = useState(
    service?.baseUrl ?? vendor?.regions[0].baseUrl ?? ''
  )
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? '')
  const [workspaceUrl, setWorkspaceUrl] = useState(() => {
    const url = service?.baseUrl
    return isQwenWorkspaceBaseUrl(url) ? url : ''
  })
  const [adapter, setAdapter] = useState<ImageAdapterKind>(service?.adapter ?? 'openai-images')
  const [models, setModels] = useState<ImageServiceModel[]>(
    service?.models ?? [
      {
        id: crypto.randomUUID(),
        wireModelId: '',
        presetId: 'openai-images/generic'
      }
    ]
  )
  const [apiKey, setApiKey] = useState('')
  const [keyVisible, setKeyVisible] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const provider = snapshot.availableProviders.find((provider) => provider.id === providerId)
  const qwen = vendorId === 'bailian'
  const workspace = qwen ? workspaceUrl.trim().replace(/\/$/, '') : ''
  const selectedBaseUrl = vendor ? workspace || officialBaseUrl : baseUrl.trim()
  const selectedAdapter = vendor?.adapter ?? adapter
  const presets = (Object.keys(presetLabels) as ImageModelPresetId[]).filter(
    (id) => IMAGE_MODEL_PRESET_ADAPTERS[id] === adapter
  )
  const reuseKey =
    service?.configured &&
    !service.providerId &&
    service.baseUrl === selectedBaseUrl &&
    service.adapter === selectedAdapter
  const keyRequired = !providerId && customProviderRequiresKey(selectedBaseUrl) && !reuseKey
  const endpointError = selectedBaseUrl ? getCustomProviderBaseUrlError(selectedBaseUrl) : undefined
  const invalidWorkspace = !!workspace && !isQwenWorkspaceBaseUrl(workspace)
  const invalid =
    invalidWorkspace ||
    (providerId
      ? !provider
      : !selectedBaseUrl ||
        Boolean(endpointError) ||
        (keyRequired && !apiKey.trim()) ||
        (!vendor && models.some((model) => !/^[a-zA-Z0-9._:/-]+$/.test(model.wireModelId.trim()))))
  const draft: ImageServiceConfiguration = {
    id,
    name: name.trim() || vendor?.label || t('Custom HTTP service'),
    adapter: selectedAdapter,
    ...(vendor ? { vendorId: vendor.id } : {}),
    ...(providerId ? { providerId } : {}),
    ...(!providerId || workspace ? { baseUrl: selectedBaseUrl } : {}),
    models: vendor?.models ?? models
  }
  const updateModel = (index: number, patch: Partial<ImageServiceModel>): void =>
    setModels((models) => models.map((model, i) => (i === index ? { ...model, ...patch } : model)))
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || invalid) return
        void onSave(draft, providerId ? undefined : apiKey)
      }}
    >
      <fieldset disabled={busy} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <div className="space-y-1.5">
          <Label className={fieldLabelClassName} htmlFor="image-service-account">
            {t('Provider type')}
          </Label>
          <Select
            value={vendorId}
            disabled={busy}
            onValueChange={(value: ImageVendorId | 'custom') => {
              setVendorId(value)
              const next = IMAGE_VENDOR_CATALOG.find((entry) => entry.id === value)
              setProviderId(
                snapshot.availableProviders.find((entry) => entry.vendorId === value)?.id
              )
              setOfficialBaseUrl(next?.regions[0].baseUrl ?? '')
              setWorkspaceUrl('')
              setApiKey('')
              setKeyVisible(false)
            }}
          >
            <SelectTrigger id="image-service-account">
              <span className="flex min-w-0 items-center gap-2">
                <ProviderKindIcon kindKey={vendor ? `official:${vendor.id}` : 'custom'} />
                <span className="truncate">{vendor?.label ?? t('Custom HTTP service')}</span>
              </span>
            </SelectTrigger>
            <SelectContent scrollToTopOnOpen>
              <SelectGroup>
                <SelectLabel>{t('Official API')}</SelectLabel>
                {IMAGE_VENDOR_CATALOG.map((vendor) => (
                  <SelectItem
                    key={vendor.id}
                    value={vendor.id}
                    icon={<ProviderKindIcon kindKey={`official:${vendor.id}`} />}
                  >
                    <span className="truncate">{vendor.label}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>{t('Other')}</SelectLabel>
                <SelectItem value="custom" icon={<ProviderKindIcon kindKey="custom" />}>
                  {t('Custom HTTP service')}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className={fieldLabelClassName} htmlFor="image-service-name">
            {t('Name')}
          </Label>
          <Input
            id="image-service-name"
            value={name}
            maxLength={80}
            placeholder={vendor?.label ?? t('Optional display name')}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {vendor && accounts.length > 0 && (
          <div className="space-y-1.5">
            <Label className={fieldLabelClassName} htmlFor="image-service-credentials">
              {t('Credentials')}
            </Label>
            <Select
              value={providerId ?? 'separate'}
              disabled={busy}
              onValueChange={(value) => {
                setProviderId(value === 'separate' ? undefined : value)
                setApiKey('')
                setKeyVisible(false)
              }}
            >
              <SelectTrigger id="image-service-credentials">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
                <SelectItem value="separate">{t('Separate API key')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {vendor && !providerId && vendor.regions.length > 1 && (
          <div className="space-y-1.5">
            <Label className={fieldLabelClassName} htmlFor="image-service-region">
              {t('Region')}
            </Label>
            <Select
              value={officialBaseUrl}
              disabled={busy}
              onValueChange={(value) => {
                setOfficialBaseUrl(value)
                setApiKey('')
                setKeyVisible(false)
              }}
            >
              <SelectTrigger id="image-service-region">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {vendor.regions.map((region) => (
                  <SelectItem key={region.id} value={region.baseUrl}>
                    {region.id === 'china' ? t('China') : t('Global')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {(!vendor || qwen) && (
          <div className="space-y-1.5">
            <Label className={fieldLabelClassName} htmlFor="image-service-url">
              {t('Base URL')}
            </Label>
            <Input
              id="image-service-url"
              value={qwen ? workspaceUrl : baseUrl}
              placeholder={
                qwen
                  ? 'https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
                  : undefined
              }
              maxLength={2048}
              onChange={(event) => {
                if (qwen) setWorkspaceUrl(event.target.value)
                else setBaseUrl(event.target.value)
                setApiKey('')
                setKeyVisible(false)
              }}
              aria-invalid={invalidWorkspace || Boolean(endpointError)}
            />
            {invalidWorkspace ? (
              <p role="alert" className="text-xs text-destructive">
                {t('Enter a Bailian workspace URL.')}
              </p>
            ) : (
              endpointError && (
                <p role="alert" className="text-xs text-destructive">
                  {t(endpointError)}
                </p>
              )
            )}
          </div>
        )}
        <div className="space-y-1.5">
          <Label className={fieldLabelClassName} htmlFor="image-service-key">
            {t('API key')}
          </Label>
          <div className="relative">
            <Input
              id="image-service-key"
              type={providerId || keyVisible ? 'text' : 'password'}
              autoComplete="new-password"
              value={providerId ? (provider?.maskedKey ?? t('stored key')) : apiKey}
              readOnly={Boolean(providerId)}
              maxLength={16384}
              className="pe-9"
              placeholder={
                reuseKey
                  ? t('{{masked}} — leave blank to keep', {
                      masked: service?.maskedKey ?? t('stored key')
                    })
                  : customProviderRequiresKey(selectedBaseUrl)
                    ? t('Paste API key')
                    : t('Leave blank for a local server')
              }
              required={keyRequired}
              onChange={(event) => setApiKey(event.target.value)}
            />
            {!providerId && (
              <button
                type="button"
                aria-label={keyVisible ? t('Hide API key') : t('Show API key')}
                aria-pressed={keyVisible}
                onClick={() => setKeyVisible((visible) => !visible)}
                className="absolute inset-y-0 end-0 flex w-9 items-center justify-center rounded-e-lg text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
              >
                {keyVisible ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        </div>
        {vendor ? (
          <div className="space-y-1.5">
            <span className={fieldLabelClassName}>{t('Supported models')}</span>
            <div className="flex flex-wrap gap-1.5">
              {vendor.models.map((model) => (
                <span
                  key={model.id}
                  title={model.wireModelId}
                  className="max-w-full truncate rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {model.label ?? model.wireModelId}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label className={fieldLabelClassName} htmlFor="image-service-protocol">
                {t('API format')}
              </Label>
              <Select
                value={adapter}
                onValueChange={(value: ImageAdapterKind) => {
                  setAdapter(value)
                  setApiKey('')
                  setKeyVisible(false)
                  setModels((models) =>
                    models.map((model) => ({
                      ...model,
                      presetId: defaultPresets[value]
                    }))
                  )
                }}
              >
                <SelectTrigger id="image-service-protocol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(adapterLabels) as ImageAdapterKind[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {adapterLabels[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <span className={fieldLabelClassName}>{t('Models')}</span>
              <TooltipProvider>
                <div className="space-y-3">
                  {models.map((model, index) => (
                    <div
                      key={model.id}
                      className={`grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 ${presets.length > 1 ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]' : ''}`}
                    >
                      <div
                        className={`grid min-w-0 gap-1.5 ${presets.length > 1 ? 'col-span-2 sm:col-span-1' : ''}`}
                      >
                        <Label className={fieldLabelClassName} htmlFor={`image-model-${model.id}`}>
                          {t('Model ID')}
                        </Label>
                        <Input
                          id={`image-model-${model.id}`}
                          value={model.wireModelId}
                          maxLength={256}
                          onChange={(event) =>
                            updateModel(index, { wireModelId: event.target.value })
                          }
                        />
                      </div>
                      {presets.length > 1 ? (
                        <div className="grid min-w-0 gap-1.5">
                          <Label
                            className={fieldLabelClassName}
                            htmlFor={`image-preset-${model.id}`}
                          >
                            {t('Interface preset')}
                          </Label>
                          <Select
                            value={model.presetId}
                            onValueChange={(presetId: ImageModelPresetId) =>
                              updateModel(index, { presetId })
                            }
                          >
                            <SelectTrigger id={`image-preset-${model.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {presets.map((id) => (
                                <SelectItem key={id} value={id}>
                                  {presetLabels[id]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
                      <SettingsIconAction
                        label={t('Remove model')}
                        icon={Trash2}
                        disabled={models.length === 1}
                        onClick={() =>
                          setModels((models) => models.filter((entry) => entry.id !== model.id))
                        }
                      />
                    </div>
                  ))}
                </div>
              </TooltipProvider>
              <SettingsListAddAction
                disabled={models.length >= 16}
                onClick={() =>
                  setModels((models) => [
                    ...models,
                    {
                      id: crypto.randomUUID(),
                      wireModelId: '',
                      presetId: defaultPresets[adapter]
                    }
                  ])
                }
              >
                {t('Add model')}
              </SettingsListAddAction>
            </div>
          </>
        )}
      </fieldset>
      <ImageServiceTest
        request={{ kind: 'save', ...draft, ...(!providerId ? { apiKey } : {}) }}
        disabled={busy || Boolean(invalid)}
      />
      <SettingsFormFooter>
        <div className="flex items-center gap-2">
          {onRemove &&
            (confirmRemove ? (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => void onRemove()}
              >
                {t('Confirm removal')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                {t('Remove service')}
              </Button>
            ))}
          <Button
            type="button"
            variant="ghost"
            className="ml-auto"
            disabled={busy}
            onClick={onCancel}
          >
            {t('Cancel')}
          </Button>
          <Button type="submit" disabled={busy || Boolean(invalid)}>
            {busy ? t('Saving…') : t('Save')}
          </Button>
        </div>
      </SettingsFormFooter>
    </form>
  )
}
