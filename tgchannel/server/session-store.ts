/**
 * Session store for center manager.
 * Tracks all registered Claude instances and the active instance.
 */

export type InstanceKind = 'mcp' | 'agent-sdk'

export type Instance = {
  sessionId: string
  kind: InstanceKind
  pid: number
  label: string
  lastMessage: string
  cwd: string
  claudeSessionId?: string
  registeredAt: number
  lastActivityAt: number
}

export class SessionStore {
  private instances = new Map<string, Instance>()
  private activeSessionId: string | null = null

  // Pending restore: remembers the last active session across center restarts
  private pendingRestoreId: string | null = null
  private pendingRestoreAt: number = 0

  /**
   * Remember the last active session before center restart.
   * When this session reconnects before the timeout expires, auto-activate it.
   */
  setPendingRestore(sessionId: string | null): void {
    this.pendingRestoreId = sessionId
    this.pendingRestoreAt = Date.now()
  }

  clearPendingRestore(): void {
    this.pendingRestoreId = null
    this.pendingRestoreAt = 0
  }

  shouldAutoActivate(sessionId: string, timeoutMs: number): boolean {
    if (this.pendingRestoreId !== sessionId) return false
    return (Date.now() - this.pendingRestoreAt) < timeoutMs
  }

  register(inst: Instance): void {
    this.instances.set(inst.sessionId, inst)
    if (this.activeSessionId === null) {
      this.activeSessionId = inst.sessionId
    }
    this.updateActivity(inst.sessionId)
  }

  unregister(sessionId: string): void {
    this.instances.delete(sessionId)
    if (this.activeSessionId === sessionId) {
      // Pick the most recently active instance
      this.activeSessionId = this.pickMostRecent()
    }
  }

  updateActivity(sessionId: string): void {
    const inst = this.instances.get(sessionId)
    if (inst) {
      inst.lastActivityAt = Date.now()
    }
  }

  updateLastMessage(sessionId: string, msg: string): void {
    const inst = this.instances.get(sessionId)
    if (inst) {
      inst.lastMessage = msg
      inst.lastActivityAt = Date.now()
    }
  }

  updateClaudeSessionId(sessionId: string, claudeSessionId: string | null): void {
    const inst = this.instances.get(sessionId)
    if (inst) {
      if (claudeSessionId) {
        inst.claudeSessionId = claudeSessionId
      } else {
        delete inst.claudeSessionId
      }
      inst.lastActivityAt = Date.now()
    }
  }

  setActive(sessionId: string): boolean {
    if (!this.instances.has(sessionId)) return false
    this.activeSessionId = sessionId
    this.updateActivity(sessionId)
    return true
  }

  getActive(): string | null {
    return this.activeSessionId
  }

  getInstance(sessionId: string): Instance | undefined {
    return this.instances.get(sessionId)
  }

  getAllInstances(): Instance[] {
    return Array.from(this.instances.values()).sort(
      (a, b) => b.lastActivityAt - a.lastActivityAt,
    )
  }

  private pickMostRecent(): string | null {
    const all = this.getAllInstances()
    return all.length > 0 ? all[0]!.sessionId : null
  }
}
