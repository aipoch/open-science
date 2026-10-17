import { ApplicationPresentationHost } from '@/ApplicationPresentationHost'
import { SessionPackageImportError } from '@/components/SessionPackageImportError'
import { SessionPackageOperation } from '@/components/SessionPackageOperation'
import { ResearchExecutionConfigurationDialog } from '@/components/ResearchExecutionConfigurationDialog'

const App = (): React.JSX.Element => (
  <>
    <ApplicationPresentationHost />
    <SessionPackageOperation />
    <SessionPackageImportError />
    <ResearchExecutionConfigurationDialog />
  </>
)

export default App
