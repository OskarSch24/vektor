export interface GraphWriteSnapshot {
  path: string;
  contents: string;
  generation: number;
  revision: number | null;
}

export interface GraphWriteResult {
  path: string;
}

export type GraphWriter = (path: string, contents: string) => Promise<GraphWriteResult>;

interface QueuedGraphWrite extends GraphWriteSnapshot {
  key: string;
  promise: Promise<GraphWriteResult>;
  resolve: (value: GraphWriteResult) => void;
  reject: (error: unknown) => void;
}

/**
 * Serialises graph-file writes across documents and deduplicates identical
 * document revisions. Keeping this queue independent from React lets the
 * workspace decide whether a completed write still belongs to its active
 * document, while this service owns only ordering and liveness.
 */
export class GraphWriteQueue {
  private readonly write: GraphWriter;
  private running = false;
  private current: QueuedGraphWrite | null = null;
  private readonly jobs: QueuedGraphWrite[] = [];
  private readonly byKey = new Map<string, Promise<GraphWriteResult>>();

  constructor(write: GraphWriter) {
    this.write = write;
  }

  enqueue(snapshot: GraphWriteSnapshot): Promise<GraphWriteResult> {
    const key = this.keyFor(snapshot);
    const existing = this.byKey.get(key);
    if (existing) return existing;

    let resolveJob!: (value: GraphWriteResult) => void;
    let rejectJob!: (error: unknown) => void;
    const promise = new Promise<GraphWriteResult>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });

    this.byKey.set(key, promise);
    this.jobs.push({ ...snapshot, key, promise, resolve: resolveJob, reject: rejectJob });
    this.runNext();
    return promise;
  }

  /**
   * Waits until every current or queued write for `path` has settled. The
   * queue is checked again after each batch because a newer revision may be
   * enqueued while an older write is still running.
   */
  async waitForPath(path: string): Promise<void> {
    for (;;) {
      const pending = new Set<Promise<GraphWriteResult>>();
      if (this.current?.path === path) pending.add(this.current.promise);
      for (const job of this.jobs) {
        if (job.path === path) pending.add(job.promise);
      }
      if (pending.size === 0) return;
      await Promise.all(pending);
    }
  }

  private keyFor(snapshot: GraphWriteSnapshot): string {
    return `${snapshot.generation}\u0000${snapshot.revision ?? 'clean'}\u0000${snapshot.path}`;
  }

  private runNext(): void {
    if (this.running) return;
    const job = this.jobs.shift();
    if (!job) return;

    this.running = true;
    this.current = job;

    let write: Promise<GraphWriteResult>;
    try {
      write = this.write(job.path, job.contents);
    } catch (error) {
      write = Promise.reject(error);
    }

    void write
      .then(job.resolve)
      .catch(job.reject)
      .finally(() => {
        this.byKey.delete(job.key);
        this.current = null;
        this.running = false;
        this.runNext();
      });
  }
}
