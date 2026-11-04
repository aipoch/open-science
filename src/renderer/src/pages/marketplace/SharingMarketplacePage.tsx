import { useState } from 'react'
import { ArrowLeft, GalleryHorizontalEnd, PanelLeft, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { UseCaseCarousel } from '../home/UseCaseCarousel'

export const SharingMarketplacePage = (): React.JSX.Element => {
  const { t } = useTranslation()
  const returnToProject = useNavigationStore((state) => state.returnToProject)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const hasActiveProject = useProjectStore((state) =>
    state.projects.some(
      (project) => project.id === activeProjectId && project.archivedAt === undefined
    )
  )
  const returnLabel = hasActiveProject ? t('Back to Project') : t('Back to Home')
  const [collapsed, setCollapsed] = useState(false)
  const toggleLabel = collapsed ? t('Expand sidebar panel') : t('Collapse sidebar panel')

  // Match Library's module shell while keeping the public catalog independent of local projects.
  return (
    <div className="flex h-svh min-h-0 overflow-hidden bg-bg-10 text-text-000">
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
                <h1 className="truncate text-sm font-semibold">{t('Sharing marketplace')}</h1>
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={t('Discover and reuse research examples')}
                >
                  {t('Discover and reuse research examples')}
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
          onClick={() => returnToProject('user')}
        >
          <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
          {!collapsed && <span className="hidden sm:inline">{returnLabel}</span>}
        </Button>
        <nav aria-label={t('Sharing marketplace')} className="border-t border-border pt-3">
          <div
            aria-current="page"
            title={t('Use Case Marketplace')}
            className={cn(
              'flex min-h-9 items-center justify-center gap-2 rounded-lg bg-bg-200 text-sm font-medium',
              !collapsed && 'sm:justify-start sm:px-3'
            )}
          >
            <GalleryHorizontalEnd className="size-4 shrink-0" aria-hidden="true" />
            {!collapsed && <span className="hidden sm:inline">{t('Use Case Marketplace')}</span>}
          </div>
        </nav>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <UseCaseCarousel variant="marketplace" />
      </main>
    </div>
  )
}
