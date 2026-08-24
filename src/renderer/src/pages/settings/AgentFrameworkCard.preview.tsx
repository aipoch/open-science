/* Hallmark · AgentFrameworkCard 8-state development preview; not mounted in production. */
import { AgentFrameworkCard, type AgentFrameworkCardPreviewState } from './AgentFrameworkCard'
import { getCodexInstallSources } from '../../../../shared/settings'

const STATES: AgentFrameworkCardPreviewState[] = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
]

const AgentFrameworkCardPreview = (): React.JSX.Element => (
  <div className="grid max-w-3xl gap-3 bg-background p-5 text-foreground">
    {STATES.map((state) => {
      const success = state === 'success'
      return (
        <div key={state} className="grid gap-2 sm:grid-cols-[5rem_minmax(0,1fr)] sm:items-start">
          <span className="pt-3 font-mono text-xs text-muted-foreground">{state}</span>
          <AgentFrameworkCard
            previewState={state}
            icon={<span className="font-mono text-xs">C</span>}
            name="Codex"
            description="OpenAI coding agent connected through the Codex ACP adapter."
            ready={success}
            updateRequired={!success}
            minimumVersion="1.6.2"
            needsRepair={false}
            version={success ? '1.6.2' : '1.1.4'}
            path="/data/codex-managed/adapter/dist/index.js"
            sourceLabel="agentclientprotocol/codex-acp"
            sourceUrl="https://github.com/agentclientprotocol/codex-acp"
            notReadyHint="Codex ACP v1.1.4 is no longer supported. Update to v1.6.2 or later to use Codex."
            active={false}
            onSelect={() => undefined}
            selectDisabled={state === 'disabled'}
            uninstallCommand="npm uninstall -g @agentclientprotocol/codex-acp"
            managed
            isUninstalling={false}
            isDetecting={false}
            onUninstall={() => undefined}
            showUninstall={false}
            installSources={getCodexInstallSources()}
            install={{ isInstalling: false, installLogs: [], installProgress: null }}
            installRunning={false}
            npmAvailable
            blockedInstallSources={{}}
            onInstall={() => undefined}
          />
        </div>
      )
    })}
  </div>
)

export { AgentFrameworkCardPreview }
