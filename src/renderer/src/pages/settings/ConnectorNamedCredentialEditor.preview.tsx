/* Hallmark · ConnectorNamedCredentialEditor 8-state development preview; not mounted in production. */
import { useState } from 'react'

import type { DeviceCredentialView } from '../../../../shared/settings'
import {
  ConnectorNamedCredentialEditor,
  type NamedCredentialPreviewState
} from './ConnectorNamedCredentialEditor'

const STATES: NamedCredentialPreviewState[] = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
]

const credentials: DeviceCredentialView[] = [
  {
    id: 'preview-api-token',
    displayName: 'Example API token',
    kind: 'token',
    status: 'stored',
    consumerCount: 1,
    consumerNames: ['Example Connector'],
    createdAt: 1,
    updatedAt: 1
  }
]

const StatePreview = ({ state }: { state: NamedCredentialPreviewState }): React.JSX.Element => {
  const [text, setText] = useState('API_TOKEN=')
  const [bindings, setBindings] = useState<Record<string, string>>({
    API_TOKEN: credentials[0].id
  })

  return (
    <section className="grid gap-3 rounded-xl border border-border p-4">
      <p className="text-xs text-muted-foreground">{state}</p>
      <ConnectorNamedCredentialEditor
        kind="environment"
        text={text}
        onTextChange={setText}
        credentials={credentials}
        credentialIdForName={(name) => bindings[name]}
        onCredentialChange={(name, credentialId) =>
          setBindings((current) => ({ ...current, [name]: credentialId }))
        }
        onNameChange={(previousName, nextName) =>
          setBindings((current) => {
            const next = { ...current }
            const credentialId = next[previousName]
            delete next[previousName]
            if (credentialId && nextName) next[nextName] = credentialId
            return next
          })
        }
        onRemoveName={(name) =>
          setBindings((current) => {
            const next = { ...current }
            delete next[name]
            return next
          })
        }
        onCreateCredential={() => undefined}
        previewState={state}
      />
    </section>
  )
}

const ConnectorNamedCredentialEditorPreview = (): React.JSX.Element => (
  <div className="grid max-w-4xl gap-5 bg-background p-5 text-foreground">
    {STATES.map((state) => (
      <StatePreview key={state} state={state} />
    ))}
  </div>
)

export { ConnectorNamedCredentialEditorPreview }
