import { LiteratureRendererProvider } from '@/pages/literature/public/host'
import { literatureRendererHost } from '@/lib/literature-renderer-host'
import { ApplicationPresentationHost } from '@/ApplicationPresentationHost'
import { SessionPackageImportError } from '@/components/SessionPackageImportError'
import { ResearchExecutionConfigurationDialog } from '@/components/ResearchExecutionConfigurationDialog'

const App = (): React.JSX.Element => (
  <LiteratureRendererProvider host={literatureRendererHost}>
    <ApplicationPresentationHost />
    <SessionPackageImportError />
    <ResearchExecutionConfigurationDialog />
  </LiteratureRendererProvider>
)

export default App
