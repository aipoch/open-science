import { TriangleAlert } from 'lucide-react'

// Shared advisory shown wherever the data-root folder is chosen or displayed (onboarding's
// Location step, Settings' Storage panel): the folder's contents are managed by the app and must
// not be hand-edited, or projects/history can break. Uses the amber "waiting" tone (role="note")
// rather than the red destructive tone so it reads as guidance, not an error.
const DataRootWarning = (): React.JSX.Element => (
  <p
    role="note"
    className="flex items-start gap-2 rounded-lg border border-session-waiting/40 bg-session-waiting/10 px-3 py-2 text-xs text-session-waiting"
  >
    <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
    <span>
      Open Science manages this folder. Don&apos;t move, rename, or delete files inside it — doing
      so can break your projects and history.
    </span>
  </p>
)

export { DataRootWarning }
