/* Hallmark · component preview: run marks · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus · active · disabled · loading · error · success
 */
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

import { runMarkIndicatorClassName } from './workspace-run-marks'

type PreviewMarkState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

type PreviewState = {
  label: string
  markState: PreviewMarkState
  disabled?: boolean
  triggerClassName?: string
}

const WorkspaceRunMarksPreview = (): React.JSX.Element => {
  const { t } = useTranslation()
  const previewStates: PreviewState[] = [
    { label: t('Default'), markState: 'default' },
    { label: t('Hover'), markState: 'hover' },
    {
      label: t('Focus'),
      markState: 'focus',
      triggerClassName: 'outline-2 outline-offset-1 outline-ring/60 [&>span]:w-3'
    },
    {
      label: t('Active'),
      markState: 'active',
      triggerClassName: '[&>span]:translate-x-px'
    },
    { label: t('Disabled'), markState: 'disabled', disabled: true },
    { label: t('Loading'), markState: 'loading' },
    { label: t('Error'), markState: 'error' },
    { label: t('Success'), markState: 'success' }
  ]

  return (
    <section className="grid w-72 gap-3 rounded-xl border border-border-200 bg-bg-000 p-4 text-text-000 shadow-dialog">
      <header className="grid gap-1">
        <h1 className="text-sm font-semibold">{t('Run marks')}</h1>
        <p className="text-xs leading-5 text-text-100">{t('Component-state inspection surface')}</p>
      </header>
      <div className="grid grid-cols-2 gap-2">
        {previewStates.map((state) => (
          <div
            key={state.label}
            className="grid grid-cols-[4rem_1fr] items-center gap-2 rounded-lg bg-bg-100 px-2.5 py-2"
          >
            <span className="text-xs text-text-100">{state.label}</span>
            <button
              type="button"
              aria-label={t('{{state}} Run Mark', { state: state.label })}
              className={cn(
                'group/run-mark flex h-6 items-center rounded-sm ps-1 outline-none disabled:cursor-not-allowed disabled:opacity-40',
                state.triggerClassName
              )}
              disabled={state.disabled}
            >
              <span
                aria-hidden="true"
                className={cn(
                  runMarkIndicatorClassName(
                    ['hover', 'focus', 'active'].includes(state.markState) ? 0 : null,
                    0
                  ),
                  state.markState === 'loading' && 'animate-pulse motion-reduce:animate-none',
                  state.markState === 'error' && 'border-t-2 border-dashed border-danger-000',
                  state.markState === 'success' && 'bg-text-200'
                )}
              />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

export { WorkspaceRunMarksPreview }
