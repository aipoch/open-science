import { LiteratureRendererProvider } from '@/pages/literature/public/host'
import { literatureRendererHost } from '@/lib/literature-renderer-host'
import { ApplicationPresentationHost } from '@/ApplicationPresentationHost'
import { SessionPackageImportError } from '@/components/SessionPackageImportError'

const App = (): React.JSX.Element => (
  <LiteratureRendererProvider host={literatureRendererHost}>
    <ApplicationPresentationHost />
    <SessionPackageImportError />
  </LiteratureRendererProvider>
)

export default App
