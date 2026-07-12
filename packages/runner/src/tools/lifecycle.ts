export class TerminalOutcomeGuard {
  private finished = false;

  run(action: () => void): boolean {
    if (this.finished) return false;
    this.finished = true;
    action();
    return true;
  }
}
