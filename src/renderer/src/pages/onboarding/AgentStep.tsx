import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { AgentPanel } from '../settings/AgentPanel'
import { ClaudeInstallCard } from '../settings/ClaudeInstallCard'
import { ClaudeStatusCard } from '../settings/ClaudeStatusCard'
import { CodexStatusCard } from '../settings/CodexStatusCard'
import { OpencodeStatusCard } from '../settings/OpencodeStatusCard'
import { EnvironmentSetupCard } from './EnvironmentSetupCard'
import { useAgentEnvironment, useEnvironmentReady } from './use-agent-environment'

// Framework switcher + Automatic/Manual install surface. The automatic tab is the one-click
// app-managed install over the live check result; the manual tab keeps the original per-framework
// installer cards as an advanced fallback.
const AgentEnvironmentPanel = (): React.JSX.Element => {
  const {
    agentFrameworkId,
    agentFrameworks,
    claude,
    opencode,
    codex,
    preflight,
    isDetectingClaude,
    isDetectingOpencode,
    isDetectingCodex,
    isInstalling,
    installBusy,
    installLogs,
    installProgress,
    storeInstallError,
    npmAvailable,
    environmentCheck,
    environmentCheckError,
    isCheckingEnvironment,
    environmentMode,
    setEnvironmentMode,
    showFrameworkSwitcher,
    setShowFrameworkSwitcher,
    automaticInstallError,
    handleEnvironmentCheck,
    handleInstall,
    handlePickFramework
  } = useAgentEnvironment()

  const frameworkSwitcher =
    agentFrameworks.length > 1 ? (
      <div className="rounded-lg bg-bg-10 p-3 ring-1 ring-border-200">
        {preflight.agentReady && !showFrameworkSwitcher ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs leading-5 text-text-300">
              Open Science will use{' '}
              <span className="font-medium text-text-100">
                {agentFrameworks.find((f) => f.id === agentFrameworkId)?.displayName ??
                  'the selected agent'}
              </span>
              . Only this agent needs to be installed to continue.
            </span>
            <button
              type="button"
              onClick={() => setShowFrameworkSwitcher(true)}
              className="shrink-0 text-xs font-medium text-text-100 underline-offset-2 hover:text-text-000 hover:underline"
            >
              Change agent
            </button>
          </div>
        ) : (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-text-100">
              Which agent should Open Science use?
            </span>
            <div
              className={cn(
                'grid gap-1 rounded-md bg-bg-000 p-1 ring-1 ring-border-200',
                agentFrameworks.length >= 3 ? 'grid-cols-3' : 'grid-cols-2'
              )}
              role="radiogroup"
              aria-label="Agent framework"
            >
              {agentFrameworks.map((framework) => (
                <button
                  key={framework.id}
                  type="button"
                  role="radio"
                  aria-checked={agentFrameworkId === framework.id}
                  onClick={() => handlePickFramework(framework.id)}
                  disabled={
                    isCheckingEnvironment ||
                    isInstalling ||
                    isDetectingClaude ||
                    isDetectingOpencode ||
                    isDetectingCodex
                  }
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60',
                    agentFrameworkId === framework.id
                      ? 'bg-bg-10 text-text-000 shadow-sm ring-1 ring-border-200'
                      : 'text-text-100 hover:text-text-000'
                  )}
                >
                  {framework.displayName}
                </button>
              ))}
            </div>
            <p className="text-xs leading-5 text-text-300">
              Only this agent needs to be installed to continue; you can change it later in
              Settings.
            </p>
          </div>
        )}
      </div>
    ) : null

  const modePanels = (
    <>
      <div
        className="grid grid-cols-2 gap-1 rounded-lg bg-bg-10 p-1 ring-1 ring-border-200"
        role="tablist"
        aria-label="Environment setup mode"
      >
        <button
          type="button"
          role="tab"
          aria-selected={environmentMode === 'automatic'}
          aria-controls="automatic-environment-panel"
          id="automatic-environment-tab"
          onClick={() => setEnvironmentMode('automatic')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            environmentMode === 'automatic'
              ? 'bg-bg-000 text-text-000 shadow-sm ring-1 ring-border-200'
              : 'text-text-100 hover:text-text-000'
          )}
        >
          Automatic detection
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={environmentMode === 'manual'}
          aria-controls="manual-environment-panel"
          id="manual-environment-tab"
          onClick={() => setEnvironmentMode('manual')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            environmentMode === 'manual'
              ? 'bg-bg-000 text-text-000 shadow-sm ring-1 ring-border-200'
              : 'text-text-100 hover:text-text-000'
          )}
        >
          Manual setup
        </button>
      </div>

      {environmentMode === 'automatic' ? (
        <div
          id="automatic-environment-panel"
          role="tabpanel"
          aria-labelledby="automatic-environment-tab"
          className="space-y-5"
        >
          <EnvironmentSetupCard
            environment={environmentCheck}
            isChecking={isCheckingEnvironment}
            isInstalling={isInstalling}
            installBusy={installBusy}
            installLogs={installLogs}
            installProgress={installProgress}
            error={automaticInstallError ?? storeInstallError ?? environmentCheckError}
            onCheck={() => void handleEnvironmentCheck()}
            onInstall={() => void handleInstall('managed')}
          />
        </div>
      ) : (
        <div
          id="manual-environment-panel"
          role="tabpanel"
          aria-labelledby="manual-environment-tab"
          className="space-y-5"
        >
          <p className="rounded-lg bg-bg-10 px-3 py-2 text-xs leading-relaxed text-text-100 ring-1 ring-border-200">
            Advanced fallback: pick the original installer source and copyable scripts. Use
            Re-detect after completing any external permission or installation step.
          </p>
          {/* Only the selected framework's runtime is shown — it is the one that must be
              installed to continue. Switch frameworks above to set up the other. */}
          {agentFrameworkId === 'codex' ? (
            <CodexStatusCard
              codex={codex}
              codexReady={preflight.codexReady}
              isDetecting={isDetectingCodex || isCheckingEnvironment}
              onDetect={() => void handleEnvironmentCheck()}
              isInstalling={isInstalling}
              installLogs={installLogs}
              installProgress={installProgress}
              installError={storeInstallError}
              installBusy={installBusy}
              npmAvailable={npmAvailable}
              onInstall={(source) => void handleInstall(source, 'codex')}
            />
          ) : agentFrameworkId === 'opencode' ? (
            <OpencodeStatusCard
              opencode={opencode}
              opencodeReady={preflight.opencodeReady}
              isDetecting={isDetectingOpencode || isCheckingEnvironment}
              onDetect={() => void handleEnvironmentCheck()}
              isInstalling={isInstalling}
              installLogs={installLogs}
              installProgress={installProgress}
              installError={storeInstallError}
              installBusy={installBusy}
              npmAvailable={npmAvailable}
              onInstall={(source) => void handleInstall(source, 'opencode')}
            />
          ) : (
            // Same boxed shell as OpencodeStatusCard so both frameworks read identically:
            // one card holding the runtime status and, when missing, the install picker.
            <Card className="gap-0 rounded-lg py-0">
              <CardContent className="space-y-3 p-4">
                <ClaudeStatusCard
                  claude={claude}
                  claudeReady={preflight.claudeReady}
                  isDetecting={isDetectingClaude || isCheckingEnvironment}
                  onDetect={() => void handleEnvironmentCheck()}
                  embedded
                />
                {!preflight.claudeReady ? (
                  <ClaudeInstallCard
                    isInstalling={isInstalling}
                    installLogs={installLogs}
                    installProgress={installProgress}
                    installError={storeInstallError}
                    installBusy={installBusy}
                    npmAvailable={npmAvailable}
                    onInstall={(source) => void handleInstall(source, 'claude-code')}
                    embedded
                  />
                ) : null}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </>
  )

  return (
    <>
      {modePanels}
      {frameworkSwitcher}
    </>
  )
}

type AgentStepProps = {
  onBack: () => void
  onContinue: () => void
}

// Agent runtime step: pick the framework Open Science drives and get that runtime installed.
// Continue requires the environment check to pass for the CURRENTLY selected framework.
const AgentStep = ({ onBack, onContinue }: AgentStepProps): React.JSX.Element => {
  const environmentReady = useEnvironmentReady()

  return (
    <>
      <CardContent className="flex-1 p-0">
        <AgentPanel
          variant="onboarding"
          title="Set up the agent runtime"
          description="Pick the agent Open Science drives, then install it. Only this agent needs to be installed to continue."
        />
      </CardContent>
      <CardFooter className="mt-auto items-center justify-between gap-4 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
        <p className="text-xs leading-5 text-text-100">
          {environmentReady
            ? 'All required environment checks passed.'
            : 'Complete every required item above to continue.'}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button type="button" onClick={onContinue} disabled={!environmentReady} className="px-4">
            Continue
          </Button>
        </div>
      </CardFooter>
    </>
  )
}

export { AgentStep, AgentEnvironmentPanel }
