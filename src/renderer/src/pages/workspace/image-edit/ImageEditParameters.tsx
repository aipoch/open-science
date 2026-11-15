import { imageOptionLabels } from '../image-tool-presentation'
import { useId } from 'react'
import { Check, ChevronDown, ChevronRight, Settings, SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/settings-store'
import { ProviderKindIcon } from '../../settings/provider-icons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu'
import type {
  ImageModelBinding,
  ImageModelSettingsSnapshot
} from '../../../../../shared/image-model-settings'
import {
  getImageModelPreset,
  type ImageOptionValue
} from '../../../../../shared/image-model-presets'

export function ImageEditParameters({
  settings,
  settingsError,
  model,
  options,
  disabled,
  onModel,
  onOptions
}: {
  settings?: ImageModelSettingsSnapshot
  settingsError: boolean
  model?: ImageModelBinding
  options: Record<string, ImageOptionValue>
  disabled: boolean
  onModel(model: ImageModelBinding, options: Record<string, ImageOptionValue>): void
  onOptions(options: Record<string, ImageOptionValue>): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const openImageServices = useSettingsStore((state) => state.openSettingsToImageServices)
  const services = (settings?.services ?? [])
    .filter(({ configured }) => configured)
    .map((entry) => ({
      entry,
      models: entry.models.filter(
        (candidate) => getImageModelPreset(candidate.presetId)?.operations.edit
      )
    }))
    .filter(({ models }) => models.length > 0)
  const service = services.find(({ entry }) => entry.id === model?.serviceId)
  const selected = service?.models.find(({ id }) => id === model?.modelId)
  const providerIcon = (
    entry: ImageModelSettingsSnapshot['services'][number]
  ): React.JSX.Element => {
    const vendor =
      entry.vendorId ??
      settings?.availableProviders?.find(({ id }) => id === entry.providerId)?.vendorId
    return (
      <ProviderKindIcon
        kindKey={vendor ? `official:${vendor}` : 'custom'}
        className="size-4 shrink-0"
      />
    )
  }
  const spec = selected ? getImageModelPreset(selected.presetId)?.operations.edit : undefined
  const labels = imageOptionLabels(t)
  const set = (key: string, value: ImageOptionValue | undefined): void => {
    const next = { ...options }
    if (value === undefined) delete next[key]
    else next[key] = value
    if (key === 'size' && value && value !== 'auto') {
      delete next.aspect_ratio
      delete next.area
    }
    if (key === 'aspect_ratio' || key === 'area') delete next.size
    if (key === 'output_format' && value !== 'jpeg' && value !== 'jpg' && value !== 'webp')
      delete next.output_compression
    if (key === 'prompt_extend' && value === false) delete next.enable_thinking
    onOptions(next)
  }
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="min-w-0 max-w-64 shrink gap-1.5 text-text-100"
            aria-label={t('Image model')}
          >
            {selected && service ? providerIcon(service.entry) : null}
            <span className="truncate">
              {selected?.label ?? selected?.wireModelId ?? t('Select model')}
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="top"
          className="z-[80] w-72 max-w-[calc(100vw-2rem)]"
        >
          {services.length === 0 ? (
            <>
              <DropdownMenuLabel className="text-xs font-normal text-text-300">
                {settingsError
                  ? t('Settings could not be loaded')
                  : settings
                    ? t('No model available')
                    : t('Loading…')}
              </DropdownMenuLabel>
              {settings || settingsError ? (
                <DropdownMenuItem onSelect={openImageServices} className="gap-2">
                  <Settings className="size-4 shrink-0" />
                  {t('Image services')}
                </DropdownMenuItem>
              ) : null}
            </>
          ) : (
            services.map(({ entry, models }) => (
              <div key={entry.id}>
                <DropdownMenuLabel className="truncate text-xs text-text-300">
                  {entry.name}
                </DropdownMenuLabel>
                {models.map((candidate) => (
                  <DropdownMenuItem
                    key={candidate.id}
                    onSelect={() =>
                      onModel(
                        { serviceId: entry.id, modelId: candidate.id },
                        candidate.presetId === 'minimax-h3/sglang' ? { size: '1024x1024' } : {}
                      )
                    }
                    className="min-w-0 gap-2"
                    aria-current={selected?.id === candidate.id && service?.entry.id === entry.id}
                  >
                    {providerIcon(entry)}
                    <span className="min-w-0 flex-1 truncate">
                      {candidate.label ?? candidate.wireModelId}
                    </span>
                    {selected?.id === candidate.id && service?.entry.id === entry.id ? (
                      <Check className="size-3.5 shrink-0 text-primary" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </div>
            ))
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={disabled || !spec}
              className={spec ? 'gap-2' : 'hidden'}
            >
              <SlidersHorizontal className="size-4 shrink-0" />
              <span className="flex-1">{t('Output settings')}</span>
              <ChevronRight className="size-3.5 shrink-0" />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              align="end"
              alignOffset={-6}
              className="z-[80] w-72 max-h-[min(28rem,60vh)] overflow-auto p-3"
              // Nested selects restore focus through their portal; keep the parameter form open.
              onFocusOutside={(event) => event.preventDefault()}
              onKeyDownCapture={(event) => {
                if (event.key === 'Tab') event.stopPropagation()
              }}
            >
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] items-center gap-x-3 gap-y-3">
                {Object.entries(spec?.options ?? {})
                  .filter(([key]) => {
                    if (key === 'enable_thinking' && options.prompt_extend === false) return false
                    if (key !== 'output_compression') return true
                    const format = options.output_format ?? spec?.options.output_format?.default
                    return format === 'jpeg' || format === 'jpg' || format === 'webp'
                  })
                  .map(([key, field]) => (
                    <div className="contents" key={key}>
                      <label htmlFor={`${id}-${key}`} className="truncate text-xs text-text-200">
                        {labels[key] ?? key}
                      </label>
                      {field.kind === 'enum' ? (
                        <Select
                          value={String(options[key] ?? '__default')}
                          onValueChange={(value) =>
                            set(key, value === '__default' ? undefined : value)
                          }
                        >
                          <SelectTrigger id={`${id}-${key}`} className="h-8 min-w-0 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="z-[90]">
                            <SelectItem value="__default">{t('Model default')}</SelectItem>
                            {field.values.map((value) => (
                              <SelectItem key={value} value={value}>
                                {value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : field.kind === 'boolean' ? (
                        <Switch
                          id={`${id}-${key}`}
                          checked={(options[key] ?? field.default) === true}
                          onCheckedChange={(value) => set(key, value)}
                        />
                      ) : (
                        <Input
                          id={`${id}-${key}`}
                          type={field.kind === 'integer' ? 'number' : 'text'}
                          min={field.kind === 'integer' ? field.min : undefined}
                          max={field.kind === 'integer' ? field.max : undefined}
                          maxLength={field.kind === 'text' ? field.maxLength : undefined}
                          step={field.kind === 'integer' ? 1 : undefined}
                          value={options[key] === undefined ? '' : String(options[key])}
                          placeholder={
                            field.kind === 'size'
                              ? String(field.default ?? '1024x1024')
                              : field.kind === 'aspect-ratio'
                                ? '16:9'
                                : field.default === undefined
                                  ? t('Model default')
                                  : String(field.default)
                          }
                          className="h-8 min-w-0 text-xs"
                          onKeyDown={(event) => {
                            if (event.key !== 'Escape' && event.key !== 'Tab')
                              event.stopPropagation()
                          }}
                          onChange={(event) =>
                            set(
                              key,
                              event.target.value === ''
                                ? undefined
                                : field.kind === 'integer'
                                  ? Number(event.target.value)
                                  : event.target.value
                            )
                          }
                        />
                      )}
                    </div>
                  ))}
              </div>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
