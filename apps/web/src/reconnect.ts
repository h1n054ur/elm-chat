export const MAX_RECONNECT_ATTEMPTS = 5;

export function reconnectDelayMs(attempt: number): number | null {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= MAX_RECONNECT_ATTEMPTS) {
    return null;
  }
  return Math.min(500 * 2 ** attempt, 8000);
}

// Share one budget across failed socket connections and metadata requests.
export class ReconnectScheduler {
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private exhausted = false;

  constructor(
    private readonly allowed: () => boolean,
    private readonly retry: () => void,
    private readonly scheduled: (delay: number) => void
  ) {}

  schedule(): boolean {
    if (!this.allowed()) return false;
    if (this.timer !== null) return true;
    const delay = reconnectDelayMs(this.attempt);
    if (delay === null) {
      this.exhausted = true;
      return false;
    }
    this.attempt += 1;
    this.scheduled(delay);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.allowed()) this.retry();
    }, delay);
    return true;
  }

  get canRetry(): boolean {
    return this.exhausted && this.allowed();
  }

  retryNow(): boolean {
    if (!this.canRetry) return false;
    // Consume eligibility before invoking the callback, including same-tick clicks.
    this.reset();
    this.retry();
    return true;
  }

  reset(): void {
    this.cancel();
    this.attempt = 0;
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.exhausted = false;
  }
}
