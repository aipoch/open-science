import { ApplicationPresentationHost } from '@/ApplicationPresentationHost'
import { SessionPackageImportError } from '@/components/SessionPackageImportError'

const App = (): React.JSX.Element => (
  <>
    <ApplicationPresentationHost />
    <SessionPackageImportError />
  </>
)

export default App
