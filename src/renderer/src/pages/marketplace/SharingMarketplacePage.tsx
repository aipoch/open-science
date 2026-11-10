import { ConnectorsNavIcon } from '../settings/connector-icons'
import { ResourceDetailActions, ResourceDetailActionsProvider } from './ResourceDetailLayout'
import { SkillUsageAgents } from '../settings/SkillUsageAgents'
import { specialistsUsingSkill } from '../settings/specialist-resource-scope'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  GalleryHorizontalEnd,
  LoaderCircle,
  PanelLeft,
  ScrollText,
  Store,
  Users,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import * as Dialog from '@/components/ui/dialog'
import { dialogOverlayClassName } from '@/components/ui/dialog-chrome'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ResourceNavigationProvider, ResourceCatalogPending } from './ResourceCenterModeTabs'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import { SettingsIconAction } from '../settings/SettingsLayout'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { cn } from '@/lib/utils'
import { useNavigationStore, type ResourceCenterResource } from '@/stores/navigation-store'
import { useMarketplaceStore } from '@/stores/marketplace-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { UseCaseCarousel } from '../home/UseCaseCarousel'
import type { SkillsView, SpecialistsView, ConnectorsView } from '../../lib/settings-navigation'
import { SettingsEditorActionsProvider } from '../settings/SettingsLayout'
import type { SkillEditorLeaveState } from '../settings/SkillEditor'
import type { SpecialistUsage } from '../settings/specialist-resource-scope'

const SkillsPanel = lazy(async () => {
  const module = await import('../settings/SkillsPanel')
  return { default: module.SkillsPanel }
})

const SpecialistsPanel = lazy(async () => {
  const module = await import('../settings/SpecialistsPanel')
  return { default: module.SpecialistsPanel }
})

const ConnectorResourcePanel = lazy(async () => ({
  default: (await import('../settings/ConnectorResourcePanel')).ConnectorResourcePanel
}))

const ResourceCenterLoading = ({ label }: { label: string }): React.JSX.Element => (
  <div className="flex min-h-32 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
    <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    <span>{label}</span>
  </div>
)

const RetainedResourceCatalog = ({
  active,
  marketplace,
  children
}: {
  active: boolean
  marketplace: boolean
  children: ReactNode
}): React.JSX.Element => {
  const viewport = useRef<HTMLDivElement>(null)
  const scrollTop = useRef(0)
  useLayoutEffect(() => {
    if (active && viewport.current) viewport.current.scrollTop = scrollTop.current
  }, [active])
  return (
    <div
      ref={viewport}
      data-resource-catalog={marketplace ? 'marketplace' : 'installed'}
      className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', !active && 'hidden')}
      aria-hidden={!active}
      onScroll={(event) => {
        if (active && event.currentTarget.clientHeight > 0)
          scrollTop.current = event.currentTarget.scrollTop
      }}
    >
      {children}
    </div>
  )
}

// Each visited catalog owns its DOM and scroll viewport until this Center closes.
// Hidden catalogs retain filters and pagination while their shared stores stay current.
const RetainedResourceCatalogs = ({
  marketplace,
  children
}: {
  marketplace: boolean
  children: (marketplace: boolean, active: boolean) => ReactNode
}): React.JSX.Element => {
  const [visitedMarketplace, setVisitedMarketplace] = useState(marketplace)
  if (marketplace && !visitedMarketplace) setVisitedMarketplace(true)
  return (
    <>
      {[false, true].map((isMarketplace) => {
        if (isMarketplace && !visitedMarketplace) return null
        const active = isMarketplace === marketplace
        return (
          <RetainedResourceCatalog
            key={String(isMarketplace)}
            marketplace={isMarketplace}
            active={active}
          >
            {children(isMarketplace, active)}
          </RetainedResourceCatalog>
        )
      })}
    </>
  )
}

type ResourceDetail =
  | { resource: 'connectors'; view: Extract<ConnectorsView, { kind: 'detail' }> }
  | { resource: 'skills'; view: Extract<SkillsView, { kind: 'detail' | 'marketplace-detail' }> }
  | {
      resource: 'specialists'
      view: Extract<SpecialistsView, { kind: 'edit' | 'builtin' | 'marketplace-release' }>
    }

export const SharingMarketplacePage = ({
  embedded = false,
  skillDetailRequest,
  previewScope
}: {
  embedded?: boolean
  skillDetailRequest?: { skillId: string }
  previewScope?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const returnToProject = useNavigationStore((state) => state.returnToProject)
  const resourceCenterIntent = useNavigationStore((state) => state.resourceCenterIntent)
  const initialIntent = embedded ? undefined : resourceCenterIntent
  const appliedIntent = useRef(initialIntent)
  const clearResourceCenterIntent = useNavigationStore((state) => state.clearResourceCenterIntent)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const hasActiveProject = useProjectStore((state) =>
    state.projects.some(
      (project) => project.id === activeProjectId && project.archivedAt === undefined
    )
  )
  const returnLabel = hasActiveProject ? t('Back to Project') : t('Back to Home')
  const [collapsed, setCollapsed] = useState(false)
  const [activeResource, setActiveResource] = useState<ResourceCenterResource>(
    initialIntent?.resource ?? 'skills'
  )
  const [visitedResources, setVisitedResources] = useState<ReadonlySet<ResourceCenterResource>>(
    () => new Set([initialIntent?.resource ?? 'skills'])
  )
  const [marketplaceRevision, setMarketplaceRevision] = useState(0)
  const [skillsView, setSkillsView] = useState<SkillsView>({ kind: 'list' })
  const [specialistsView, setSpecialistsView] = useState<SpecialistsView>({ kind: 'list' })
  const [connectorsView, setConnectorsView] = useState<ConnectorsView>(
    initialIntent?.resource === 'connectors' && initialIntent.view?.kind !== 'detail'
      ? (initialIntent.view ?? { kind: 'list' })
      : { kind: 'list' }
  )
  const [connectorLeaveState, setConnectorLeaveState] = useState<SkillEditorLeaveState | null>(null)
  const connectorHistory = useRef<ConnectorsView[]>([])
  const connectors = useSettingsStore((state) => state.connectors)
  const customServers = useSettingsStore((state) => state.customServers)
  const [detail, setDetail] = useState<ResourceDetail | null>(() => {
    if (initialIntent?.resource === 'connectors' && initialIntent.view?.kind === 'detail')
      return { resource: 'connectors', view: initialIntent.view }
    if (initialIntent?.resource === 'skills' && initialIntent.skillId) {
      return { resource: 'skills', view: { kind: 'detail', id: initialIntent.skillId } }
    }
    if (initialIntent?.resource === 'specialists' && initialIntent.specialistId) {
      return {
        resource: 'specialists',
        view: {
          kind: initialIntent.specialistKind === 'builtin' ? 'builtin' : 'edit',
          id: initialIntent.specialistId
        }
      }
    }
    return null
  })
  const displayedDetail = useRetainedDialogValue(detail)
  const detailTrigger = useRef<HTMLElement | null>(null)
  const mainRef = useRef<HTMLElement>(null)
  const detailBackRef = useRef<HTMLButtonElement>(null)
  const restoreDetailFocus = (): void => {
    const trigger = detailTrigger.current
    if (trigger?.isConnected && trigger.getClientRects().length > 0)
      trigger.focus({ preventScroll: true })
    else mainRef.current?.focus({ preventScroll: true })
  }
  const closeDetail = (): void => {
    setDetail(null)
    if (embedded) requestAnimationFrame(restoreDetailFocus)
  }
  useLayoutEffect(() => {
    if (embedded && detail) detailBackRef.current?.focus({ preventScroll: true })
  }, [embedded, detail])
  const openDetail = (next: ResourceDetail): void => {
    if (!detail)
      detailTrigger.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDetail(next)
  }
  const [editorActionsContainer, setEditorActionsContainer] = useState<HTMLDivElement | null>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [skillLeaveState, setSkillLeaveState] = useState<SkillEditorLeaveState | null>(null)
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const skillHistory = useRef<SkillsView[]>([{ kind: 'list' }])
  const specialistHistory = useRef<SpecialistsView[]>([{ kind: 'list' }])
  const skills = useSettingsStore((state) => state.skills)
  const specialists = useSpecialistStore((state) => state.items)
  const marketplace = useMarketplaceStore((state) => state.snapshot)

  const navigateSkills = (view: SkillsView): void => {
    if (view.kind === 'detail' || view.kind === 'marketplace-detail') {
      openDetail({ resource: 'skills', view })
      return
    }
    if (detail && (view.kind === 'list' || view.kind === 'marketplace')) {
      setDetail(null)
      return
    }
    setDetail(null)
    if (view.kind === 'list') skillHistory.current = []
    else skillHistory.current.push(skillsView)
    setSkillsView(view)
    commitResourceSelection('skills')
  }
  const navigateSpecialists = (view: SpecialistsView): void => {
    const specialist =
      view.kind === 'edit' ? specialists.find((item) => item.id === view.id) : undefined
    if (
      view.kind === 'builtin' ||
      view.kind === 'marketplace-release' ||
      (view.kind === 'edit' &&
        !(!detail && specialistsView.kind === 'import') &&
        !(specialist?.kind === 'custom' && specialist.setupPending))
    ) {
      openDetail({ resource: 'specialists', view })
      return
    }
    if (detail && (view.kind === 'list' || view.kind === 'marketplace')) {
      setDetail(null)
      return
    }
    setDetail(null)
    if (view.kind === 'list') specialistHistory.current = []
    else specialistHistory.current.push(specialistsView)
    setSpecialistsView(view)
    commitResourceSelection('specialists')
  }

  const navigateConnectors = (view: ConnectorsView): void => {
    commitResourceSelection('connectors')
    if (view.kind === 'detail') {
      openDetail({ resource: 'connectors', view })
      return
    }
    setDetail(null)
    if (view.kind === 'list') connectorHistory.current = []
    else connectorHistory.current.push(connectorsView)
    setConnectorsView(view)
  }
  const openConnector = (id: string): void => {
    requestLeave(() => {
      const custom = customServers.find((server) => server.id === id || server.name === id)
      navigateConnectors(custom ? { kind: 'edit', id: custom.id } : { kind: 'detail', id })
    })
  }
  const leaveState = activeResource === 'connectors' ? connectorLeaveState : skillLeaveState
  const requestLeave = useCallback(
    (action: () => void): void => {
      if (editorBusy || leaveState?.busy) return
      if (leaveState?.dirty) {
        setPendingLeave(() => action)
        return
      }
      action()
    },
    [editorBusy, leaveState]
  )
  useEffect(() => {
    if (!previewScope) return
    return previewLeaveGuards.register(
      previewScope,
      (action) => {
        if (editorBusy || leaveState?.busy) return false
        if (leaveState?.dirty) {
          setPendingLeave(() => () => previewLeaveGuards.runApproved(previewScope, action))
          return false
        }
        return true
      },
      () => Boolean(leaveState?.dirty)
    )
  }, [previewScope, editorBusy, leaveState])

  const appliedSkillRequest = useRef<typeof skillDetailRequest>(undefined)
  useEffect(() => {
    if (!embedded || !skillDetailRequest || appliedSkillRequest.current === skillDetailRequest)
      return
    appliedSkillRequest.current = skillDetailRequest
    requestLeave(() => {
      setActiveResource('skills')
      setVisitedResources((current) => new Set([...current, 'skills']))
      setDetail({ resource: 'skills', view: { kind: 'detail', id: skillDetailRequest.skillId } })
    })
  }, [embedded, skillDetailRequest, requestLeave])

  const toggleLabel = collapsed ? t('Expand sidebar panel') : t('Collapse sidebar panel')

  useEffect(() => {
    if (embedded || !resourceCenterIntent) return
    const intent = resourceCenterIntent
    if (appliedIntent.current !== intent) {
      appliedIntent.current = intent
      requestLeave(() => {
        setActiveResource(intent.resource)
        setVisitedResources((current) => new Set([...current, intent.resource]))
        setDetail(null)
        if (intent.resource === 'connectors') {
          const view = intent.view ?? { kind: 'list' }
          if (view.kind === 'detail') setDetail({ resource: 'connectors', view })
          else setConnectorsView(view)
        } else if (intent.resource === 'skills' && intent.skillId) {
          setDetail({ resource: 'skills', view: { kind: 'detail', id: intent.skillId } })
        } else if (intent.resource === 'specialists' && intent.specialistId) {
          setDetail({
            resource: 'specialists',
            view: {
              kind: intent.specialistKind === 'builtin' ? 'builtin' : 'edit',
              id: intent.specialistId
            }
          })
        }
      })
    }
    clearResourceCenterIntent()
  }, [clearResourceCenterIntent, resourceCenterIntent, embedded, requestLeave])

  const commitResourceSelection = (resource: ResourceCenterResource): void => {
    setActiveResource(resource)
    setVisitedResources((current) => {
      if (current.has(resource)) return current
      return new Set([...current, resource])
    })
  }

  const selectResource = (resource: ResourceCenterResource): void => {
    if (resource === activeResource) return
    requestLeave(() => commitResourceSelection(resource))
  }

  const confirmResourceLeave = (): void => {
    if (!pendingLeave || leaveState?.busy) return
    const action = pendingLeave
    setPendingLeave(null)
    setSkillLeaveState(null)
    if (activeResource === 'connectors') {
      setConnectorLeaveState(null)
      connectorHistory.current = []
      setConnectorsView({ kind: 'list' })
    } else {
      skillHistory.current = []
      setSkillsView({ kind: 'list' })
    }
    action()
  }

  const openSpecialist = (usage: SpecialistUsage): void => {
    requestLeave(() =>
      navigateSpecialists(
        usage.kind === 'builtin'
          ? { kind: 'builtin', id: usage.id }
          : { kind: 'edit', id: usage.id }
      )
    )
  }

  const openSkill = (id: string): void => {
    requestLeave(() => navigateSkills({ kind: 'detail', id }))
  }

  const [detailActionContainer, setDetailActionContainer] = useState<HTMLDivElement | null>(null)
  const previewSkill =
    displayedDetail?.resource === 'skills' && displayedDetail.view.kind === 'detail'
      ? skills.find((item) => item.id === displayedDetail.view.id)
      : undefined
  const skillUsages = previewSkill ? specialistsUsingSkill(specialists, previewSkill.id) : []
  const previewSpecialist =
    displayedDetail?.resource === 'specialists' && displayedDetail.view.kind === 'edit'
      ? specialists.find((item) => item.id === displayedDetail.view.id && item.kind === 'custom')
      : undefined
  const canEditPreview =
    (previewSkill?.source === 'personal' && previewSkill.available !== false) ||
    (previewSpecialist?.kind === 'custom' && previewSpecialist.origin !== 'marketplace')
  const detailTitle =
    displayedDetail?.resource === 'skills'
      ? displayedDetail.view.kind === 'marketplace-detail'
        ? displayedDetail.view.displayName
        : (skills.find((skill) => skill.id === displayedDetail.view.id)?.displayName ??
          displayedDetail.view.id)
      : displayedDetail?.resource === 'connectors'
        ? (connectors.find((item) => item.id === displayedDetail.view.id)?.displayName ??
          displayedDetail.view.id)
        : displayedDetail
          ? (() => {
              if (displayedDetail.view.kind === 'marketplace-release') {
                const view = displayedDetail.view
                return (
                  marketplace?.specialists.find(
                    (item) => item.id === view.id && item.sourceId === view.sourceId
                  )?.displayName ?? view.id
                )
              }
              const specialist = specialists.find((item) => item.id === displayedDetail.view.id)
              return specialist && specialist.kind !== 'reviewer'
                ? (specialist.displayName ?? specialist.name)
                : displayedDetail.view.id
            })()
          : ''
  const editPreview = (): void => {
    if (!canEditPreview || !detail) return
    if (detail.resource === 'skills') {
      navigateSkills({ kind: 'edit', id: detail.view.id })
      return
    }
    if (detail.resource !== 'specialists') return
    specialistHistory.current.push(specialistsView)
    setSpecialistsView(detail.view)
    setDetail(null)
    commitResourceSelection('specialists')
  }

  const activeView =
    activeResource === 'skills'
      ? skillsView
      : activeResource === 'connectors'
        ? connectorsView
        : specialistsView
  const showDetailNavigation =
    activeResource !== 'marketplace' &&
    activeView.kind !== 'list' &&
    activeView.kind !== 'marketplace' &&
    activeView.kind !== 'marketplace-batch' &&
    activeView.kind !== 'marketplace-sources'
  const resourceLabel =
    activeResource === 'skills'
      ? t('Skills')
      : activeResource === 'connectors'
        ? t('Connectors')
        : t('Specialists')
  const marketplaceDetail = activeView.kind.startsWith('marketplace-')
  const leafLabel = (() => {
    if (activeResource === 'connectors') {
      if (
        (connectorsView.kind === 'add' || connectorsView.kind === 'edit') &&
        connectorsView.credentialView === 'create'
      )
        return t('New credential')
      switch (connectorsView.kind) {
        case 'add':
          return t('Add connector')
        case 'edit':
          return t('Edit {{name}}', {
            name:
              customServers.find((server) => server.id === connectorsView.id)?.name ??
              t('connector')
          })
        case 'import':
          return t('Import configuration')
        case 'export':
          return t('Export')
        default:
          return ''
      }
    }
    if (activeResource === 'skills') {
      switch (skillsView.kind) {
        case 'detail':
        case 'edit': {
          const name =
            skills.find((skill) => skill.id === skillsView.id)?.displayName ?? skillsView.id
          return skillsView.kind === 'edit' ? t('Edit {{name}}', { name }) : name
        }
        case 'marketplace-detail':
          return skillsView.displayName
        case 'create':
          return t('New skill')
        case 'upload':
          return t('Upload skills')
        case 'import':
          return t('Import from GitHub')
        case 'import-agent-home':
          return t('Import installed skills')
        default:
          return ''
      }
    }
    switch (specialistsView.kind) {
      case 'edit':
      case 'builtin': {
        const specialist = specialists.find((item) => item.id === specialistsView.id)
        const name =
          specialist && specialist.kind !== 'reviewer'
            ? (specialist.displayName ?? specialist.name)
            : specialistsView.id
        return specialistsView.kind === 'edit' ? t('Edit {{name}}', { name }) : name
      }
      case 'create':
        return t('New specialist')
      case 'import':
        return t('Import ZIP')
      case 'export':
        return t('Export ZIP')
      case 'marketplace-release':
        return specialistsView.id
      default:
        return ''
    }
  })()
  const goBack = (): void => {
    if (
      activeResource === 'connectors' &&
      (connectorsView.kind === 'add' || connectorsView.kind === 'edit') &&
      connectorsView.credentialView === 'create'
    ) {
      setConnectorsView({ ...connectorsView, credentialView: undefined })
      connectorHistory.current.pop()
      return
    }
    requestLeave(() => {
      if (activeResource === 'skills') {
        setSkillsView(skillHistory.current.pop() ?? { kind: 'list' })
      } else if (activeResource === 'connectors') {
        setConnectorsView(connectorHistory.current.pop() ?? { kind: 'list' })
      } else {
        setSpecialistsView(specialistHistory.current.pop() ?? { kind: 'list' })
      }
    })
  }
  const goToResource = (marketplace = false): void =>
    requestLeave(() => {
      const view = { kind: marketplace ? 'marketplace' : 'list' } as const
      if (activeResource === 'skills') navigateSkills(view)
      else if (activeResource === 'connectors') navigateConnectors({ kind: 'list' })
      else navigateSpecialists(view)
    })

  const resourceTabs: ReadonlyArray<{
    id: ResourceCenterResource
    label: string
    Icon: React.ComponentType<{ className?: string }>
  }> = [
    { id: 'skills', label: t('Skills'), Icon: ScrollText },
    { id: 'connectors', label: t('Connectors'), Icon: ConnectorsNavIcon },
    { id: 'specialists', label: t('Specialists'), Icon: Users },
    { id: 'marketplace', label: t('Use Cases'), Icon: GalleryHorizontalEnd }
  ]

  const resourceNavigation = embedded ? (
    <div className="flex min-w-0 items-center gap-2">
      <Select
        value={activeResource}
        onValueChange={(value) => selectResource(value as ResourceCenterResource)}
      >
        <SelectTrigger
          aria-label={t('Resource type')}
          className="h-9 w-auto min-w-0 gap-2 font-semibold"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {resourceTabs.map(({ id, label, Icon }) => (
            <SelectItem key={id} value={id}>
              <span className="flex items-center gap-2">
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <TooltipProvider>
        <SettingsIconAction
          label={t('Resource center')}
          icon={ArrowUpRight}
          onClick={() =>
            requestLeave(() =>
              useNavigationStore.getState().openResourceCenter('user', { resource: activeResource })
            )
          }
        />
      </TooltipProvider>
    </div>
  ) : null

  const detailContent = (
    <ResourceDetailActionsProvider
      value={{
        container: detailActionContainer,
        onClose: closeDetail,
        closeLabel: embedded ? t('Back') : undefined
      }}
    >
      <div
        key={
          displayedDetail
            ? `${displayedDetail.resource}:${displayedDetail.view.kind}:${displayedDetail.view.id}`
            : 'closed'
        }
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [overflow-wrap:anywhere]"
      >
        <Suspense fallback={<ResourceCenterLoading label={t('Loading…')} />}>
          {displayedDetail?.resource === 'skills' && (
            <SkillsPanel
              view={displayedDetail.view}
              onMarketplaceChanged={() => setMarketplaceRevision((revision) => revision + 1)}
              onNavigate={navigateSkills}
              onOpenSpecialist={openSpecialist}
              onOpenTag={() => {
                setDetail(null)
                useSettingsStore.getState().openSettingsToPanel('tags')
              }}
            />
          )}
          {displayedDetail?.resource === 'connectors' && (
            <ConnectorResourcePanel
              view={displayedDetail.view}
              onNavigate={navigateConnectors}
              onCancel={() => setDetail(null)}
              onOpenSpecialist={openSpecialist}
            />
          )}
          {displayedDetail?.resource === 'specialists' && (
            <SpecialistsPanel
              view={displayedDetail.view}
              detailPresentation="drawer"
              onNavigate={navigateSpecialists}
              onOpenSkillDetail={openSkill}
              onOpenConnectorDetail={openConnector}
              onOpenTag={() => {
                setDetail(null)
                useSettingsStore.getState().openSettingsToPanel('tags')
              }}
            />
          )}
        </Suspense>
      </div>
      {(previewSkill ||
        canEditPreview ||
        displayedDetail?.view.kind === 'builtin' ||
        displayedDetail?.resource === 'connectors') && (
        <ResourceDetailActions
          leading={
            previewSkill && (previewSkill.enabled || skillUsages.length > 0) ? (
              <>
                <span className="text-xs text-muted-foreground">{t('Used by')}</span>
                <SkillUsageAgents
                  mainEnabled={previewSkill.enabled}
                  usages={skillUsages}
                  onOpenSpecialist={openSpecialist}
                />
              </>
            ) : undefined
          }
        >
          {canEditPreview ? <Button onClick={editPreview}>{t('Edit')}</Button> : null}
        </ResourceDetailActions>
      )}
      <div
        ref={setDetailActionContainer}
        data-slot="resource-detail-footer"
        className="shrink-0 border-t border-border bg-card px-5 py-4 empty:hidden"
      />
    </ResourceDetailActionsProvider>
  )

  // Resource center keeps discovery and installed-resource lifecycle actions in one surface. The
  // existing panels remain the owners of their stores, IPC mutations, and detail flows.
  return (
    <ResourceNavigationProvider navigation={resourceNavigation}>
      <div
        className={cn(
          'flex min-h-0 overflow-hidden bg-bg-10 text-text-000',
          embedded ? 'h-full' : 'h-svh'
        )}
      >
        {!embedded && (
          <aside
            className={cn(
              'flex shrink-0 flex-col border-r border-border-300/80 bg-bg-000 py-3',
              collapsed ? 'w-14 px-2' : 'w-14 px-2 sm:w-60 sm:px-3'
            )}
          >
            <div className="mb-3 flex min-h-10 items-center justify-center gap-2 sm:px-1">
              {!collapsed && (
                <>
                  <span className="hidden size-8 shrink-0 place-items-center rounded-lg bg-bg-200 text-primary sm:grid">
                    <Store className="size-4" aria-hidden="true" />
                  </span>
                  <div className="hidden min-w-0 flex-1 sm:block">
                    <h1 className="truncate text-sm font-semibold">{t('Resource center')}</h1>
                    <p
                      className="truncate text-xs text-muted-foreground"
                      title={t('Discover and reuse research resources')}
                    >
                      {t('Discover and reuse research resources')}
                    </p>
                  </div>
                </>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={toggleLabel}
                title={toggleLabel}
                onClick={() => setCollapsed((value) => !value)}
              >
                <PanelLeft className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <Button
              variant="ghost"
              className={cn('mb-3 h-9 w-full gap-2 px-0', !collapsed && 'sm:justify-start sm:px-3')}
              aria-label={returnLabel}
              title={returnLabel}
              onClick={() => requestLeave(() => returnToProject('user'))}
            >
              <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
              {!collapsed && <span className="hidden sm:inline">{returnLabel}</span>}
            </Button>
            <nav aria-label={t('Resource center')} className="border-t border-border pt-3">
              <ul className="flex flex-col gap-0.5">
                {resourceTabs.map(({ id, label, Icon }) => {
                  const isActive = activeResource === id
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        aria-current={isActive ? 'page' : undefined}
                        aria-label={label}
                        title={label}
                        onClick={() => selectResource(id)}
                        className={cn(
                          'flex min-h-9 w-full items-center justify-center gap-2 rounded-md text-left text-sm transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                          !collapsed && 'sm:justify-start sm:px-3',
                          isActive
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        )}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        {!collapsed && <span className="hidden truncate sm:inline">{label}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </nav>
          </aside>
        )}
        <main
          ref={mainRef}
          tabIndex={-1}
          data-resource-center-resource={activeResource}
          className={cn('flex min-h-0 min-w-0 flex-1 flex-col', embedded && detail && 'hidden')}
          aria-hidden={embedded && detail !== null}
        >
          {embedded && showDetailNavigation ? (
            <div className="px-5 pt-3">{resourceNavigation}</div>
          ) : null}
          {showDetailNavigation && (
            <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-10 px-5 py-2">
              <nav
                aria-label={t('Navigation')}
                className="flex min-w-0 flex-1 basis-full items-center gap-2 text-sm sm:basis-auto"
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Back')}
                  onClick={goBack}
                  disabled={editorBusy}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                </Button>
                <button
                  type="button"
                  onClick={() => goToResource()}
                  disabled={editorBusy}
                  className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {resourceLabel}
                </button>
                <ChevronRight
                  className="hidden size-3.5 shrink-0 text-muted-foreground sm:block"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => goToResource(marketplaceDetail)}
                  disabled={editorBusy}
                  className="hidden shrink-0 sm:block rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {marketplaceDetail ? t('Marketplace') : t('Installed')}
                </button>
                <ChevronRight
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <h2 aria-current="page" className="min-w-0 truncate font-medium" title={leafLabel}>
                  {leafLabel}
                </h2>
              </nav>
              <div
                ref={setEditorActionsContainer}
                data-slot="resource-editor-actions"
                className="ml-auto shrink-0 empty:hidden"
              />
            </header>
          )}
          <div
            className={cn('min-h-0 flex-1', activeResource !== 'marketplace' && 'hidden')}
            aria-hidden={activeResource !== 'marketplace'}
          >
            <UseCaseCarousel variant="marketplace" compact={embedded} />
          </div>
          {visitedResources.has('skills') && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col',
                activeResource !== 'skills' && 'hidden'
              )}
              aria-hidden={activeResource !== 'skills'}
            >
              <RetainedResourceCatalogs marketplace={skillsView.kind.startsWith('marketplace')}>
                {(marketplace, active) => (
                  <Suspense
                    fallback={
                      skillsView.kind === 'list' || skillsView.kind.startsWith('marketplace') ? (
                        <ResourceCatalogPending
                          title={t('Skills')}
                          icon={ScrollText}
                          mode={skillsView.kind === 'list' ? 'installed' : 'marketplace'}
                        />
                      ) : (
                        <ResourceCenterLoading label={t('Loading…')} />
                      )
                    }
                  >
                    <SettingsEditorActionsProvider
                      target={
                        activeResource === 'skills' && active
                          ? { container: editorActionsContainer, onBusyChange: setEditorBusy }
                          : null
                      }
                    >
                      <SkillsPanel
                        view={active ? skillsView : { kind: marketplace ? 'marketplace' : 'list' }}
                        marketplaceRevision={marketplaceRevision}
                        onNavigate={navigateSkills}
                        onEditorLeaveStateChange={setSkillLeaveState}
                        onSaved={() => {
                          setSkillLeaveState(null)
                          navigateSkills({ kind: 'list' })
                        }}
                        onOpenSpecialist={openSpecialist}
                        onOpenTag={() => useSettingsStore.getState().openSettingsToPanel('tags')}
                        onOpenGitHubCredential={() =>
                          useSettingsStore.getState().openSettingsToPanel('credentials')
                        }
                      />
                    </SettingsEditorActionsProvider>
                  </Suspense>
                )}
              </RetainedResourceCatalogs>
            </div>
          )}
          {visitedResources.has('connectors') && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col overflow-y-auto',
                activeResource !== 'connectors' && 'hidden'
              )}
              aria-hidden={activeResource !== 'connectors'}
            >
              <Suspense
                fallback={
                  connectorsView.kind === 'list' ? (
                    <ResourceCatalogPending
                      title={t('Connectors')}
                      icon={ConnectorsNavIcon}
                      marketplaceHidden
                    />
                  ) : (
                    <ResourceCenterLoading label={t('Loading…')} />
                  )
                }
              >
                <SettingsEditorActionsProvider
                  target={
                    activeResource === 'connectors'
                      ? { container: editorActionsContainer, onBusyChange: setEditorBusy }
                      : null
                  }
                >
                  <ConnectorResourcePanel
                    view={connectorsView}
                    active={activeResource === 'connectors'}
                    onNavigate={navigateConnectors}
                    onCancel={() => requestLeave(() => navigateConnectors({ kind: 'list' }))}
                    onLeaveStateChange={setConnectorLeaveState}
                    onOpenSpecialist={openSpecialist}
                  />
                </SettingsEditorActionsProvider>
              </Suspense>
            </div>
          )}
          {visitedResources.has('specialists') && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col',
                activeResource !== 'specialists' && 'hidden'
              )}
              aria-hidden={activeResource !== 'specialists'}
            >
              <RetainedResourceCatalogs
                marketplace={specialistsView.kind.startsWith('marketplace')}
              >
                {(marketplace, active) => (
                  <Suspense
                    fallback={
                      specialistsView.kind === 'list' ||
                      specialistsView.kind.startsWith('marketplace') ? (
                        <ResourceCatalogPending
                          title={t('Specialists')}
                          icon={Users}
                          mode={specialistsView.kind === 'list' ? 'installed' : 'marketplace'}
                        />
                      ) : (
                        <ResourceCenterLoading label={t('Loading…')} />
                      )
                    }
                  >
                    <SettingsEditorActionsProvider
                      target={
                        activeResource === 'specialists' && active
                          ? { container: editorActionsContainer, onBusyChange: setEditorBusy }
                          : null
                      }
                    >
                      <SpecialistsPanel
                        view={
                          active ? specialistsView : { kind: marketplace ? 'marketplace' : 'list' }
                        }
                        onOpenDetail={(id) =>
                          openDetail({ resource: 'specialists', view: { kind: 'edit', id } })
                        }
                        onNavigate={navigateSpecialists}
                        onOpenSkillDetail={openSkill}
                        onOpenConnectorDetail={openConnector}
                        onOpenTag={() => {
                          useSettingsStore.getState().openSettingsToPanel('tags')
                        }}
                      />
                    </SettingsEditorActionsProvider>
                  </Suspense>
                )}
              </RetainedResourceCatalogs>
            </div>
          )}
        </main>
        {embedded ? (
          detail ? (
            <section
              data-slot="resource-inline-detail"
              aria-label={detailTitle}
              className="flex min-h-0 min-w-0 flex-1 flex-col bg-card"
            >
              <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-5">
                <Button
                  ref={detailBackRef}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Back')}
                  title={t('Back')}
                  onClick={closeDetail}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                </Button>
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={detailTitle}>
                  {detailTitle}
                </h2>
              </header>
              {detailContent}
            </section>
          ) : null
        ) : (
          <Dialog.Root
            open={detail !== null}
            onOpenChange={(open) => {
              if (!open) setDetail(null)
            }}
          >
            <Dialog.Portal>
              <Dialog.Overlay className={dialogOverlayClassName} />
              <Dialog.Content
                aria-describedby={undefined}
                className="fixed inset-y-0 right-0 flex w-full data-[state=closed]:pointer-events-none flex-col border-l border-border bg-card text-foreground shadow-dialog outline-none sm:w-[min(46rem,calc(100vw-4rem))] data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right motion-reduce:animate-none"
                onCloseAutoFocus={(event) => {
                  event.preventDefault()
                  restoreDetailFocus()
                }}
              >
                <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-5">
                  <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {detailTitle}
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={t('Close')}>
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </Dialog.Close>
                </div>
                {detailContent}
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
        <ConfirmActionDialog
          open={pendingLeave !== null}
          title={t('Discard unsaved changes?')}
          description={
            activeResource === 'connectors'
              ? t('Your changes have not been saved. Discard them and leave the editor?')
              : t('Your skill edits have not been saved. Discard them and leave the editor?')
          }
          confirmLabel={t('Discard changes')}
          cancelLabel={t('Keep editing')}
          onCancel={() => {
            if (!leaveState?.busy) setPendingLeave(null)
          }}
          onConfirm={confirmResourceLeave}
          loading={leaveState?.busy === true}
        />
      </div>
    </ResourceNavigationProvider>
  )
}
