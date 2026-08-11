import { useEffect, useState, type ReactNode } from 'react'

import logo from '@/assets/logo.png'
import logoDark from '@/assets/logo-dark.png'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { Button } from '@/components/ui/button'
import type { DatabaseStartupState } from '../../../shared/database-startup'

type DatabaseStartupGateProps = { children: ReactNode }

const DatabaseStartupGate = ({ children }: DatabaseStartupGateProps): React.JSX.Element => {
  const databaseStartup = (window.api as Partial<Window['api']> | undefined)?.databaseStartup
  const [state, setState] = useState<DatabaseStartupState>(
    databaseStartup ? { phase: 'checking' } : { phase: 'ready' }
  )
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    if (!databaseStartup) return
    let disposed = false
    let receivedEvent = false
    const unsubscribe = databaseStartup.onStateChanged((next) => {
      receivedEvent = true
      if (!disposed) setState(next)
    })
    void databaseStartup.getState().then((current) => {
      if (!disposed && !receivedEvent) setState(current)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [databaseStartup])

  if (state.phase === 'ready') return <>{children}</>

  const retry = (): void => {
    if (!databaseStartup) return
    setRetrying(true)
    void databaseStartup
      .retry()
      .then(setState)
      .finally(() => setRetrying(false))
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background px-6"
      aria-live="polite"
    >
      <section className="flex w-full max-w-md flex-col items-center text-center">
        {state.phase === 'blocked' ? (
          <div className="mb-10">
            <img src={logo} alt="Open Science" className="h-12 w-auto dark:hidden" />
            <img src={logoDark} alt="Open Science" className="hidden h-12 w-auto dark:block" />
          </div>
        ) : null}

        {state.phase === 'blocked' ? (
          <div className="w-full rounded-xl border border-border bg-card p-7 text-left shadow-card">
            <h1 className="text-lg font-semibold text-card-foreground">
              Open Science couldn’t start
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{state.error.message}</p>
            <p className="mt-4 font-mono text-xs text-muted-foreground">
              Error code: {state.error.code}
              {state.error.migrationId ? ` · Migration: ${state.error.migrationId}` : ''}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" onClick={() => void databaseStartup?.quit()}>
                Quit
              </Button>
              {state.error.retryable ? (
                <Button onClick={retry} disabled={retrying}>
                  {retrying ? 'Retrying…' : 'Retry'}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-14">
            <OpenScienceLogoLoader />
            <div className="flex flex-col items-center gap-4">
              <h1 className="text-base font-medium text-foreground">
                {state.phase === 'migrating' ? 'Updating database…' : 'Checking database…'}
              </h1>
              {state.phase === 'migrating' ? (
                <p className="text-sm text-muted-foreground">
                  Keep Open Science open while this finishes.
                </p>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

export { DatabaseStartupGate }
