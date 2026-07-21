import { useEffect, useRef, useState } from 'react'

import type { PackageMirror } from '../../../../shared/mirror'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/settings-store'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { isMirrorConfigured, mirrorStatusText, MIRROR_HELP_URL } from './mirror-view'

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'
const actionButtonClassName =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50'

// Package-mirror list vs. configure form. The configure form is a settings-nav sub-view (not local
// state) so the shared header shows a "Network / Package mirror" breadcrumb with back/forward.
type NetworkView = { kind: 'list' | 'configure' }
type NetworkPanelProps = { view: NetworkView; onNavigate: (view: NetworkView) => void }

// Settings -> Network. Currently just the Package mirror section: conda-forge / pip fetch packages
// from the public hosts by default; a user behind a firewall or on a slow route to those hosts can
// point them at a mirror instead. The "Claude Science domains" egress allowlist from the mockup is
// phase-3 (spec §14, §9) and is intentionally not built here.
const NetworkPanel = ({ view, onNavigate }: NetworkPanelProps): React.JSX.Element => {
  const packageMirror = useSettingsStore((state) => state.packageMirror)
  const setPackageMirror = useSettingsStore((state) => state.setPackageMirror)

  const isConfiguring = view.kind === 'configure'
  const [draft, setDraft] = useState<PackageMirror>({})
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  // Seed the draft from the saved mirror once each time the configure view is entered (including via
  // history / a remount), without clobbering in-progress edits on a background store refresh.
  const seededRef = useRef(false)
  useEffect(() => {
    if (view.kind === 'configure') {
      if (!seededRef.current) {
        setDraft(packageMirror ?? {})
        setMessage(undefined)
        seededRef.current = true
      }
    } else {
      seededRef.current = false
    }
  }, [view.kind, packageMirror])

  const handleConfigure = (): void => onNavigate({ kind: 'configure' })

  const handleCancel = (): void => {
    setMessage(undefined)
    onNavigate({ kind: 'list' })
  }

  const handleSave = async (): Promise<void> => {
    setIsSaving(true)
    setMessage(undefined)

    try {
      await setPackageMirror(draft)
      onNavigate({ kind: 'list' })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the package mirror.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-6 p-5">
      <section aria-label="Package mirror">
        <h3 className="mb-1 text-sm font-semibold text-foreground">Package mirror</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Where the notebook environment fetches conda and Python packages from when installing or
          updating.
        </p>

        <div className="rounded-xl border border-border p-4">
          {!isConfiguring ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground">{mirrorStatusText(packageMirror)}</span>
              <button type="button" onClick={handleConfigure} className={actionButtonClassName}>
                {isMirrorConfigured(packageMirror) ? 'Edit' : 'Configure'}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-conda-channel">
                  Conda channel mirror
                </label>
                <Input
                  id="mirror-conda-channel"
                  aria-label="Conda channel mirror"
                  value={draft.condaChannel ?? ''}
                  placeholder="https://mirrors.example.com/conda-forge/"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, condaChannel: event.target.value }))
                  }
                />
              </div>

              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-pypi-index">
                  Python package index (pip)
                </label>
                <Input
                  id="mirror-pypi-index"
                  aria-label="Python package index (pip)"
                  value={draft.pypiIndex ?? ''}
                  placeholder="https://mirrors.example.com/pypi/simple"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, pypiIndex: event.target.value }))
                  }
                />
              </div>

              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-ca-bundle">
                  CA bundle path <span className="text-muted-foreground">(optional)</span>
                </label>
                <Input
                  id="mirror-ca-bundle"
                  aria-label="CA bundle path"
                  value={draft.caBundle ?? ''}
                  placeholder="/path/to/corp-ca-bundle.pem"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, caBundle: event.target.value }))
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  PEM bundle for a corporate TLS proxy; trusted by conda, pip, and R downloads.
                </p>
              </div>

              {message ? (
                <p className="text-xs text-destructive" role="alert">
                  {message}
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={isSaving}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={isSaving}
                  className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {isSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          <ExternalTextLink href={MIRROR_HELP_URL}>View available mirrors</ExternalTextLink>
        </p>
      </section>
    </div>
  )
}

export { NetworkPanel }
