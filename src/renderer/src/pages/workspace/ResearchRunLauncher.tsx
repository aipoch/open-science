import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical, LoaderCircle, X } from 'lucide-react'
import type { ResearchMembership } from '../../../../shared/session-persistence'
import {
  researchRunPlanBlockReasons,
  type ResearchRunInspection,
  type ResearchRunMaterial,
  type ResearchRunPlan
} from '../../../../shared/research-run-launcher'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { researchIdentity } from './research-draft-identity'

export type ResearchRunLaunchSelection = {
  inspection: ResearchRunInspection
  plan: ResearchRunPlan
}
export type ResearchRunLauncherProps = {
  source: ResearchMembership
  destination: { kind: 'new-discussion' } | { kind: 'current-discussion'; title: string }
  blockedReason?: string
  onStart: (selection: ResearchRunLaunchSelection) => Promise<void>
}

const PlanDetails = ({ plan }: { plan: ResearchRunPlan }): React.JSX.Element => {
  const { t } = useTranslation()
  const scope = {
    'end-to-end': t('End-to-end study'),
    'downstream-only': t('Downstream steps only'),
    'alternative-conditions': t('Alternative conditions'),
    'engineering-check': t('Engineering validation')
  }[plan.scope]
  const materialStatus: Record<ResearchRunMaterial['status'], string> = {
    available: t('Included and verified'),
    external: t('External material required'),
    withheld: t('Not shared by the author'),
    missing: t('Missing material'),
    mismatch: t('Material identity mismatch')
  }
  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-bg-100 p-3 text-sm">
      <div>
        <p className="text-xs font-medium text-text-300">{scope}</p>
        <p className="mt-1 whitespace-pre-wrap break-words">{plan.claim}</p>
      </div>
      {plan.limitations.length > 0 ? (
        <div>
          <p className="font-medium">{t('Limits of this run')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-text-200">
            {plan.limitations.map((limitation, index) => (
              <li key={index} className="whitespace-pre-wrap break-words">
                {limitation}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <details>
        <summary className="cursor-pointer font-medium">{t('Research materials')}</summary>
        <ul className="mt-2 space-y-1 text-xs text-text-200">
          {plan.materials.map((material) => (
            <li key={material.key} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
              <span className="break-all font-mono">{material.key}</span>
              <span>{materialStatus[material.status]}</span>
            </li>
          ))}
        </ul>
      </details>
      {plan.requirements?.node || plan.requirements?.platforms?.length ? (
        <div className="text-xs text-text-200">
          {plan.requirements.node ? (
            <p>{t('Required Node.js: {{version}}', { version: plan.requirements.node })}</p>
          ) : null}
          {plan.requirements.platforms?.length ? (
            <p>
              {t('Supported platforms: {{platforms}}', {
                platforms: plan.requirements.platforms.join(', ')
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const ResearchRunLauncherBody = ({
  source,
  destination,
  blockedReason,
  onStart
}: ResearchRunLauncherProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [inspection, setInspection] = useState<ResearchRunInspection>()
  const [selectedPlanKey, setSelectedPlanKey] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [inspectFailed, setInspectFailed] = useState(false)
  const [startError, setStartError] = useState<string>()
  const [starting, setStarting] = useState(false)
  const active = useRef(true)
  const requestId = useRef(0)
  const startingRef = useRef(false)
  const lastDescriptor = useRef<string | undefined>(undefined)
  const lastIdentity = useRef<string | undefined>(undefined)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const inspect = async (
    descriptorVersionId?: string,
    expectedSourceIdentity?: string
  ): Promise<void> => {
    const request = ++requestId.current
    lastDescriptor.current = descriptorVersionId
    lastIdentity.current = expectedSourceIdentity
    setInspection(undefined)
    setSelectedPlanKey(undefined)
    setInspectFailed(false)
    setStartError(undefined)
    setLoading(true)
    try {
      const result = await window.api.researchRuns.inspect({
        projectId: source.sourceProjectId,
        sourceSessionId: source.sourceSessionId,
        sourceImportId: source.sourceImportId,
        ...(descriptorVersionId ? { descriptorVersionId } : {}),
        ...(expectedSourceIdentity ? { expectedSourceIdentity } : {})
      })
      if (!active.current || requestId.current !== request) return
      setInspection(result)
      if (result.plans.length === 1) setSelectedPlanKey(result.plans[0].key)
    } catch {
      if (active.current && requestId.current === request) setInspectFailed(true)
    } finally {
      if (active.current && requestId.current === request) setLoading(false)
    }
  }
  const changeOpen = (next: boolean): void => {
    if (startingRef.current) return
    if (!next) requestId.current++
    setOpen(next)
    if (next) void inspect()
  }
  const plan = inspection?.plans.find((candidate) => candidate.key === selectedPlanKey)
  const planBlockReasons = plan ? researchRunPlanBlockReasons(plan) : []
  const blockMessages = {
    'materials-unavailable': t(
      'Required materials are unavailable. Choose another plan or supply the missing materials.'
    ),
    'runtime-unavailable': t('No compatible managed Node.js runtime is ready for this plan.'),
    'entrypoint-unavailable': t(
      'This plan has no startup instructions. Ask the Agent to prepare them.'
    ),
    'secrets-required': t(
      'Automatic credential setup is not supported for this plan. Ask the Agent for help.'
    )
  }
  const cannotStart =
    blockedReason ?? (planBlockReasons[0] ? blockMessages[planBlockReasons[0]] : undefined)
  const start = async (): Promise<void> => {
    if (
      startingRef.current ||
      loading ||
      cannotStart ||
      inspection?.status !== 'ready' ||
      !inspection.descriptor ||
      !plan
    )
      return
    startingRef.current = true
    setStarting(true)
    setStartError(undefined)
    try {
      await onStart({ inspection, plan })
      if (active.current) setOpen(false)
    } catch (error) {
      if (active.current)
        setStartError(
          error instanceof Error ? error.message : t('Could not start this run. Please retry.')
        )
    } finally {
      startingRef.current = false
      if (active.current) setStarting(false)
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
          <FlaskConical className="size-3" aria-hidden="true" />
          {t('Run…')}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName('w-[min(560px,calc(100vw-2rem))] p-0')}
          aria-busy={loading || starting}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>{t('Run this research')}</Dialog.Title>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close')}
              className={dialogCloseButtonClassName}
              disabled={starting}
              onClick={() => changeOpen(false)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className={`${dialogBodyClassName} max-h-[65vh] space-y-4 overflow-y-auto`}>
            <Dialog.Description className={dialogDescriptionClassName}>
              {t(
                'Your current Agent will prepare the sandbox and run the selected plan. Live observation opens when available.'
              )}
            </Dialog.Description>
            <p className="text-sm font-medium">
              {destination.kind === 'new-discussion'
                ? t('Results will be saved in a new discussion.')
                : t('Results will be saved in “{{title}}”.', { title: destination.title })}
            </p>
            {loading ? (
              <p role="status" className="flex items-center gap-2 text-sm text-text-300">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                {t('Checking research materials…')}
              </p>
            ) : null}
            {inspectFailed ? (
              <ErrorNotice
                inline
                tone="amber"
                description={t('Could not inspect this research. Please retry.')}
                primaryButton={{
                  label: t('Retry'),
                  onClick: () => void inspect(lastDescriptor.current, lastIdentity.current)
                }}
              />
            ) : null}
            {inspection?.status === 'no-description' ? (
              <p className="text-sm text-text-200">
                {t(
                  'This research has no run description. Ask the Agent to prepare one in the discussion.'
                )}
              </p>
            ) : null}
            {inspection?.status === 'unsupported' ? (
              <ErrorNotice
                inline
                tone="amber"
                description={t('This run description requires a newer version of Open Science.')}
              />
            ) : null}
            {inspection?.status === 'invalid' ? (
              <ErrorNotice
                inline
                tone="amber"
                description={t(
                  'This run description is invalid. Ask the Agent to check it in the discussion.'
                )}
              />
            ) : null}
            {inspection?.status === 'choose-description' ? (
              <div className="space-y-2" role="group" aria-label={t('Choose a run description')}>
                <p className="text-sm font-medium">{t('Choose a run description')}</p>
                {inspection.descriptorCandidates.map((descriptor) => (
                  <Button
                    key={descriptor.versionId}
                    variant="outline"
                    className="h-auto w-full justify-start whitespace-normal break-all py-2 text-left"
                    onClick={() => void inspect(descriptor.versionId, inspection.source.identity)}
                  >
                    {descriptor.filename}
                  </Button>
                ))}
              </div>
            ) : null}
            {inspection?.status === 'ready' ? (
              <>
                <fieldset disabled={starting} className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">{t('Choose a run plan')}</legend>
                  {inspection.plans.map((candidate) => (
                    <label
                      key={candidate.key}
                      className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
                    >
                      <input
                        type="radio"
                        name="research-run-plan"
                        className="mt-1 accent-primary"
                        checked={plan?.key === candidate.key}
                        onChange={() => {
                          setSelectedPlanKey(candidate.key)
                          setStartError(undefined)
                        }}
                      />
                      <span className="min-w-0 break-words">{candidate.title}</span>
                    </label>
                  ))}
                </fieldset>
                {plan ? <PlanDetails plan={plan} /> : null}
                {!inspection.diagnostics.nativeServiceSupported ? (
                  <p className="text-xs text-text-300">
                    {t(
                      'Interactive project pages are unavailable on this device. Logs and results remain available.'
                    )}
                  </p>
                ) : null}
                <details className="text-xs text-text-300">
                  <summary className="cursor-pointer">{t('Runtime')}</summary>
                  <p className="mt-2">
                    {t('The Agent will check runtime compatibility before execution.')}
                  </p>
                  {inspection.runtimes.length ? (
                    <ul className="mt-1 space-y-1">
                      {inspection.runtimes.map((runtime) => (
                        <li key={runtime.runtimeId}>
                          {t('Node.js {{version}} · {{platform}} · {{arch}}', {
                            version: runtime.version,
                            platform: runtime.platform,
                            arch: runtime.arch
                          })}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1">
                      {t(
                        'No managed Node.js runtime is available yet. The Agent may need to prepare one.'
                      )}
                    </p>
                  )}
                </details>
              </>
            ) : null}
            {inspection &&
            inspection.status !== 'choose-description' &&
            inspection.descriptorCandidates.length > 1 ? (
              <Button variant="ghost" size="sm" disabled={starting} onClick={() => void inspect()}>
                {t('Choose another run description')}
              </Button>
            ) : null}
            {inspection?.status === 'ready' && cannotStart ? (
              <ErrorNotice inline tone="amber" description={cannotStart} />
            ) : null}
            {startError ? <ErrorNotice inline tone="amber" description={startError} /> : null}
          </div>
          <div className={dialogFooterClassName}>
            <Button
              variant="outline"
              className={dialogCancelButtonClassName}
              disabled={starting}
              onClick={() => changeOpen(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              disabled={
                loading ||
                starting ||
                Boolean(cannotStart) ||
                inspection?.status !== 'ready' ||
                !inspection.descriptor ||
                !plan
              }
              onClick={() => void start()}
            >
              {starting ? t('Preparing…') : t('Start run')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// Changing the source invalidates the entire inspection and dialog, including in-flight replies.
export const ResearchRunLauncher = (props: ResearchRunLauncherProps): React.JSX.Element => (
  <ResearchRunLauncherBody key={researchIdentity(props.source)} {...props} />
)

export type ResearchRunStatusStage =
  'preparing' | 'running' | 'completed' | 'failed' | 'no-run' | 'unavailable'

export const ResearchRunStatus = ({
  stage,
  onOpen,
  onRetry
}: {
  stage: ResearchRunStatusStage
  onOpen?: () => void
  onRetry?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const label = {
    preparing: t('Preparing run…'),
    running: t('Run in progress'),
    completed: t('Run completed'),
    failed: t('Run failed'),
    'no-run': t('No managed run was created'),
    unavailable: t('Run status unavailable')
  }[stage]
  return (
    <div
      className="flex flex-wrap items-center gap-1 text-xs text-text-300"
      data-testid="research-run-status"
    >
      <span role="status" className="flex items-center gap-1">
        {stage === 'preparing' || stage === 'running' ? (
          <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
        ) : null}
        {label}
      </span>
      {onOpen ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onOpen}>
          {t('View run')}
        </Button>
      ) : null}
      {onRetry && (stage === 'unavailable' || stage === 'no-run') ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onRetry}>
          {t('Refresh')}
        </Button>
      ) : null}
    </div>
  )
}
