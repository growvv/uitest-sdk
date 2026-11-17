/**
 * The pinch scenario's cold-start budget.
 *
 * Lives in its own module so the acceptance script can import it without
 * importing the runner (which connects to a device on load), and so the bound
 * can be tested without one.
 */
export class RestartBudget {
  private remaining: number;

  constructor(restarts: number) {
    this.remaining = Math.max(0, restarts);
  }

  /** Consumes one restart; false once the budget is spent. */
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }

  left(): number {
    return this.remaining;
  }
}
