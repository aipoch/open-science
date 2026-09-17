import { ApplicationPresentationHost } from '@/ApplicationPresentationHost'
import { SessionPackageImportError } from '@/components/SessionPackageImportError'
import { SessionPackageOperation } from '@/components/SessionPackageOperation'

const App = (): React.JSX.Element => (
  <>
    <ApplicationPresentationHost />
    <SessionPackageOperation />
    <SessionPackageImportError />
  </>
)

export default App
