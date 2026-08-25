/* Hallmark · AppVersionSection 8-state development preview; not mounted in production. */
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useUpdateStore } from '@/stores/update-store'
import { APP } from '../../../../shared/app-config'
import type { UpdateStatus } from '../../../../shared/update'
import { AppVersionSection, type AppVersionSectionPreviewState } from './AppVersionSection'

const STATES: AppVersionSectionPreviewState[] = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
]

const statusFor = (state: AppVersionSectionPreviewState): UpdateStatus => {
  if (state === 'loading') return { state: 'checking', current: '0.18.2' }
  if (state === 'disabled') {
    return { state: 'downloading', current: '0.18.2', latest: '0.19.0', progress: 42 }
  }
  if (state === 'error') {
    return { state: 'error', current: '0.18.2', error: 'Update check failed' }
  }
  if (state === 'success') {
    return { state: 'up-to-date', current: '0.18.2', latest: '0.18.2' }
  }
  return { state: 'idle', current: '0.18.2' }
}

const AppVersionSectionPreview = (): React.JSX.Element => {
  const [state, setState] = useState<AppVersionSectionPreviewState>('default')

  useEffect(() => {
    useUpdateStore.setState({
      appInfo: {
        name: APP.name,
        version: '0.18.2',
        copyright: APP.copyright
      },
      status: statusFor(state)
    })
  }, [state])

  return (
    <div className="grid max-w-3xl gap-5 bg-background p-5 text-foreground">
      <div className="flex flex-wrap gap-2">
        {STATES.map((option) => (
          <Button
            key={option}
            type="button"
            variant={state === option ? 'secondary' : 'outline'}
            aria-pressed={state === option}
            onClick={() => setState(option)}
          >
            {option}
          </Button>
        ))}
      </div>
      <AppVersionSection previewState={state} />
    </div>
  )
}

export { AppVersionSectionPreview }
