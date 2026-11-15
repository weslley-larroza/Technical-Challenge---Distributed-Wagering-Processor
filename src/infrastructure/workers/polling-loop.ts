import type { Logger } from '../../application/ports/system';

export interface PollingLoopOptions {
  /** Delay when a tick found no work. */
  idleDelayMs: number;
  /** Delay after a tick threw (dependency down, …). */
  errorDelayMs: number;
}

/**
 * Runs `tick` repeatedly: immediately again while it reports work, waits `idleDelayMs`
 * when idle. `stop()` interrupts the wait but lets the CURRENT tick finish (graceful
 * shutdown: a claimed outbox batch is committed, not abandoned mid-way).
 */
export class PollingLoop {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    readonly name: string,
    private readonly tick: () => Promise<number>,
    private readonly options: PollingLoopOptions,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delay = this.options.idleDelayMs;
      try {
        const work = await this.tick();
        if (work > 0) delay = 0;
      } catch (error) {
        delay = this.options.errorDelayMs;
        this.logger.warn('worker tick failed', { worker: this.name, error: error instanceof Error ? error : String(error) });
      }
      if (delay > 0 && this.running) await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
