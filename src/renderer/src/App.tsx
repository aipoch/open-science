import { ApplicationPresentationHost } from '@/ApplicationPresentationHost'
import { SideChatProvider } from '@/pages/workspace/use-side-chat-controller'
import { SessionPackageImportError } from '@/components/SessionPackageImportError'
import { SessionPackageOperation } from '@/components/SessionPackageOperation'

const App = (): React.JSX.Element => (
  <SideChatProvider>
    <ApplicationPresentationHost />
    <SessionPackageOperation />
    <SessionPackageImportError />
  </SideChatProvider>
)

export default App
