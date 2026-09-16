export class SessionState {
  private injected = new Map<string, Set<string>>()
  private pending = new Map<string, string>()

  isInjected(sessionId: string, ruleId: string): boolean {
    return this.injected.get(sessionId)?.has(ruleId) ?? false
  }

  markInjected(sessionId: string, ruleId: string): void {
    let set = this.injected.get(sessionId)
    if (!set) {
      set = new Set()
      this.injected.set(sessionId, set)
    }
    set.add(ruleId)
  }

  clearSession(sessionId: string): void {
    this.injected.delete(sessionId)
  }

  setPending(callId: string, text: string): void {
    this.pending.set(callId, text)
  }

  consumePending(callId: string): string | undefined {
    const text = this.pending.get(callId)
    this.pending.delete(callId)
    return text
  }

  /** Drops stale pending entries older than the given call count (best effort). */
  prunePending(keep: Set<string>): void {
    for (const key of this.pending.keys()) {
      if (!keep.has(key)) this.pending.delete(key)
    }
  }
}
