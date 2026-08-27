import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { PersistedMessageAgentTarget } from '../../../../shared/session-persistence'
import {
  resolveProviderEffectiveModel,
  resolveProviderReasoningEffortProfile
} from '../../../../shared/provider-reasoning-effort'
import { resolveReasoningEffortControl } from '../../../../shared/reasoning-effort'

type WorkspaceSessionConfigChangeRowProps = {
  id: string
  agentTarget: PersistedMessageAgentTarget
  contentPaddingClassName?: string
}

// Marks the transcript boundary where the Session's resolved framework · model · effort changed.
const WorkspaceSessionConfigChangeRow = ({
  id,
  agentTarget,
  contentPaddingClassName
}: WorkspaceSessionConfigChangeRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const providers = useSettingsStore((state) => state.providers)

  const framework =
    agentFrameworks.find((candidate) => candidate.id === agentTarget.frameworkId)?.displayName ??
    agentTarget.frameworkId
  const provider = providers.find((candidate) => candidate.id === agentTarget.providerId)
  // An omitted model is the provider default; the Composer model picker labels that entry with
  // the provider name rather than pinning a concrete catalog model.
  const model = agentTarget.model ?? provider?.name ?? t('Default')
  // The effort line reuses the Composer picker's resolution chain so both surfaces always agree.
  const effortControl = resolveReasoningEffortControl(
    agentTarget.reasoningEffort,
    resolveProviderReasoningEffortProfile(
      provider,
      resolveProviderEffectiveModel(provider, agentTarget.model)
    )
  )
  const effort =
    agentTarget.reasoningEffort === 'default'
      ? t('Default')
      : (effortControl.options.find((option) => option.value === effortControl.selectedValue)
          ?.label ?? agentTarget.reasoningEffort)

  return (
    <MessageScrollerItem messageId={id} className="min-w-0">
      <div className={cn('px-4 pb-0.5 pt-2.5 md:px-6', contentPaddingClassName)}>
        <div
          className="flex min-w-0 items-center gap-3 py-1.5"
          data-testid="session-config-change"
          aria-label={t('Session configuration changed to {{framework}} · {{model}} · {{effort}}', {
            framework,
            model,
            effort
          })}
        >
          <span className="hidden h-px min-w-4 flex-1 bg-border-200 sm:block" aria-hidden="true" />
          <span className="flex min-w-0 max-w-[44rem] items-center gap-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border-200 bg-bg-000">
              <SlidersHorizontal
                className="size-3.5 shrink-0 text-muted-foreground"
                strokeWidth={2.2}
                aria-hidden={true}
              />
            </span>
            <span className="min-w-0 truncate text-[12px] leading-4 text-muted-foreground">
              {t('{{framework}} · {{model}} · {{effort}}', { framework, model, effort })}
            </span>
          </span>
          <span className="hidden h-px min-w-4 flex-1 bg-border-200 sm:block" aria-hidden="true" />
        </div>
      </div>
    </MessageScrollerItem>
  )
}

export { WorkspaceSessionConfigChangeRow }
