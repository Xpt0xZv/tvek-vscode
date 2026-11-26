/**
 * Strict FIFO single-flight asynchronous mutex.
 * Guarantees serialized execution of LanguageClient start/stop transitions.
 */
export class AsyncMutex {
  private queueTail: Promise<void> = Promise.resolve();
  private activeOrQueuedCount = 0;

  public get isBusy(): boolean {
    return this.activeOrQueuedCount > 0;
  }

  public get pendingCount(): number {
    return this.activeOrQueuedCount;
  }

  public runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.activeOrQueuedCount += 1;

    const previous = this.queueTail;
    let releaseCurrent!: () => void;
    this.queueTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    return previous.then(async () => {
      try {
        return await task();
      } finally {
        this.activeOrQueuedCount -= 1;
        releaseCurrent();
      }
    });
  }

  public async waitForIdle(): Promise<void> {
    while (this.activeOrQueuedCount > 0) {
      await this.queueTail;
    }
  }
}

/**
 * Coordinates immediate and debounced lifecycle reconciliations on top of an `AsyncMutex`,
 * coalescing rapid bursts of `onDidChangeConfiguration` events into a single trailing reload.
 */
export class ReloadCoordinator {
  private readonly mutex = new AsyncMutex();
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingDebouncePromise: Promise<void> | null = null;
  private resolvePendingDebounce: (() => void) | null = null;
  private disposed = false;

  public constructor(debounceMs = 150) {
    this.debounceMs = debounceMs;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public get isBusy(): boolean {
    return this.timer !== null || this.mutex.isBusy;
  }

  public scheduleDebounced(reconcileFn: () => Promise<void>): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.pendingDebouncePromise === null) {
      this.pendingDebouncePromise = new Promise<void>((resolve) => {
        this.resolvePendingDebounce = resolve;
      });
    }

    const cyclePromise = this.pendingDebouncePromise;

    this.timer = setTimeout(() => {
      this.timer = null;
      const done = this.resolvePendingDebounce;
      this.pendingDebouncePromise = null;
      this.resolvePendingDebounce = null;

      if (this.disposed) {
        done?.();
        return;
      }

      void this.mutex
        .runExclusive(reconcileFn)
        .catch(() => {
          // Errors are handled and surfaced inside reconcileFn.
        })
        .finally(() => {
          done?.();
        });
    }, this.debounceMs);

    return cyclePromise;
  }

  public runImmediate<T>(task: () => Promise<T>): Promise<T> {
    this.cancelPendingTimer();
    return this.mutex.runExclusive(task);
  }

  public cancelPendingTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.resolvePendingDebounce !== null) {
      const done = this.resolvePendingDebounce;
      this.pendingDebouncePromise = null;
      this.resolvePendingDebounce = null;
      done();
    }
  }

  public async dispose(cleanupFn: () => Promise<void>): Promise<void> {
    this.disposed = true;
    this.cancelPendingTimer();
    await this.mutex.runExclusive(cleanupFn);
  }

  public async waitForIdle(): Promise<void> {
    while (this.pendingDebouncePromise !== null || this.mutex.isBusy) {
      if (this.pendingDebouncePromise !== null) {
        await this.pendingDebouncePromise;
      }
      await this.mutex.waitForIdle();
    }
  }
}
