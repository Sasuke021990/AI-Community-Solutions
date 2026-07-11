export class ConcurrencyLimiter {
  private inFlight = 0;
  private queue: (() => void)[] = [];

  constructor(private limit: number = 2) {}

  public setLimit(limit: number) {
    this.limit = Math.max(1, Math.min(8, limit));
    this.drain();
  }

  public getLimit(): number {
    return this.limit;
  }

  public async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Aborted before acquiring concurrency slot');

    if (this.inFlight < this.limit) {
      this.inFlight++;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        this.queue = this.queue.filter(q => q !== executor);
        reject(new Error('Aborted while waiting in concurrency queue'));
      };

      const executor = () => {
        if (signal) signal.removeEventListener('abort', abortHandler);
        if (signal?.aborted) {
          // If aborted precisely when scheduled
          this.drain();
          reject(new Error('Aborted while waiting in concurrency queue'));
          return;
        }
        this.inFlight++;
        resolve();
      };

      if (signal) signal.addEventListener('abort', abortHandler);
      this.queue.push(executor);
    });
  }

  public release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.drain();
  }

  private drain() {
    while (this.inFlight < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }

  public async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
