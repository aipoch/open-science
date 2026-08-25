import { ApplicationPresentationHost } from '@/ApplicationPresentationHost'
import { SideChatProvider } from '@/pages/workspace/use-side-chat-controller'

const App = (): React.JSX.Element => (
  <SideChatProvider>
    <ApplicationPresentationHost />
  </SideChatProvider>
)

export default App
