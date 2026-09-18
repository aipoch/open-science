export type SettingsInstallLease = Readonly<{
  id: string
  release(): void
}>

export class SettingsInstallCoordinator {
  private activeId: string | undefined
  private admissionHolders = 0

  getActiveId(): string | undefined {
    return this.activeId
  }

  tryAcquire(id: string): SettingsInstallLease | undefined {
    if (this.activeId !== undefined || this.admissionHolders > 0) return undefined
    this.activeId = id
    let released = false
    return {
      id,
      release: () => {
        if (released) return
        released = true
        if (this.activeId === id) this.activeId = undefined
      }
    }
  }

  holdAdmission(): () => void {
    this.admissionHolders += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.admissionHolders -= 1
    }
  }
}
