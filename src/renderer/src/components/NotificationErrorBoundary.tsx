import { Component, type ReactNode } from 'react'

type NotificationErrorBoundaryProps = Readonly<{ children: ReactNode }>
type NotificationErrorBoundaryState = Readonly<{ failed: boolean }>

// Notifications are best-effort. Damaged notification data must never take down the app shell.
class NotificationErrorBoundary extends Component<
  NotificationErrorBoundaryProps,
  NotificationErrorBoundaryState
> {
  state: NotificationErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): NotificationErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(): void {
    // Keep the production fallback silent so notification payloads are not exposed elsewhere.
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

export { NotificationErrorBoundary }
