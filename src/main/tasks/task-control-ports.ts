type TaskControlPorts = {
  specialists: {
    resolve(reference: string): Promise<{ id: string }>
  }
}

export type { TaskControlPorts }
