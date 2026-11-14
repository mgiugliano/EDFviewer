import type {
  Annotation,
  EdfHeaderInfo,
  ScanProgress,
  ViewRequest,
  ViewResult,
} from './types.js';
import type {
  CloseRequestMsg,
  OpenRequestMsg,
  PrefetchRequestMsg,
  ScanRequestMsg,
  CancelScanRequestMsg,
  ViewRequestMsg,
  WorkerOutMessage,
} from './protocol.js';

type PromiseCallbacks = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
};

/**
 * Main-thread client wrapper around the EDF Web Worker.
 */
export class EdfClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, PromiseCallbacks>();

  private progressListeners = new Set<(progress: ScanProgress) => void>();
  private annotationsListeners = new Set<
    (annotations: Annotation[], done: boolean) => void
  >();

  constructor(customWorker?: Worker) {
    this.worker =
      customWorker ??
      new Worker(new URL('../../worker/edf.worker.ts', import.meta.url), {
        type: 'module',
      });

    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);
  }

  private handleMessage(e: MessageEvent<WorkerOutMessage>) {
    const msg = e.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'open_result': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error));
          } else {
            p.resolve(msg.header!);
          }
        }
        break;
      }

      case 'view_result': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.stale) {
            p.resolve(null);
          } else if (msg.error) {
            p.reject(new Error(msg.error));
          } else {
            p.resolve(msg.result!);
          }
        }
        break;
      }

      case 'progress': {
        for (const listener of this.progressListeners) {
          listener(msg.progress);
        }
        break;
      }

      case 'annotations': {
        for (const listener of this.annotationsListeners) {
          listener(msg.items, msg.done);
        }
        break;
      }

      case 'close_result': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(undefined);
        }
        break;
      }

      case 'error': {
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          p.reject(new Error(msg.message));
        }
        break;
      }
    }
  }

  private handleError(e: ErrorEvent) {
    console.error('EdfClient worker error:', e);
    for (const [id, p] of this.pending.entries()) {
      p.reject(new Error(`Worker error: ${e.message}`));
      this.pending.delete(id);
    }
  }

  /**
   * Opens an EDF/EDF+ File, parses the header, and begins background overview indexing.
   */
  async open(file: File): Promise<EdfHeaderInfo> {
    const id = this.nextId++;
    const msg: OpenRequestMsg = { id, type: 'open', file };

    return new Promise<EdfHeaderInfo>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(msg);
    });
  }

  /**
   * Requests a multi-channel viewport trace rendering.
   * Resolves to ViewResult, or null if this request was superseded by a newer one (latest-view-wins).
   */
  async view(req: ViewRequest): Promise<ViewResult | null> {
    const id = this.nextId++;
    // Strip any Svelte reactive proxies so structured clone in postMessage never throws DataCloneError
    const plainReq: ViewRequest = JSON.parse(JSON.stringify(req));
    const msg: ViewRequestMsg = { id, type: 'view', req: plainReq };

    return new Promise<ViewResult | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(msg);
    });
  }

  /**
   * Warms the LRU cache for upcoming time window [t0, t1] at low priority.
   */
  prefetch(t0: number, t1: number): void {
    const msg: PrefetchRequestMsg = { type: 'prefetch', t0, t1 };
    this.worker.postMessage(msg);
  }

  /**
   * Starts or resumes background whole-file scan for decimation pyramid & annotations.
   */
  startScan(): void {
    const msg: ScanRequestMsg = { type: 'scan' };
    this.worker.postMessage(msg);
  }

  /**
   * Cancels any running background scan.
   */
  cancelScan(): void {
    const msg: CancelScanRequestMsg = { type: 'cancelScan' };
    this.worker.postMessage(msg);
  }

  /**
   * Subscribes to overview scan progress reports.
   * Returns an unsubscribe function.
   */
  onProgress(cb: (progress: ScanProgress) => void): () => void {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }

  /**
   * Subscribes to extracted annotations during scan.
   * Returns an unsubscribe function.
   */
  onAnnotations(
    cb: (annotations: Annotation[], done: boolean) => void
  ): () => void {
    this.annotationsListeners.add(cb);
    return () => this.annotationsListeners.delete(cb);
  }

  /**
   * Closes the EDF file, clears caches, and terminates the worker.
   */
  async close(): Promise<void> {
    const id = this.nextId++;
    const msg: CloseRequestMsg = { id, type: 'close' };

    await new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(msg);
    });

    this.worker.terminate();
    this.progressListeners.clear();
    this.annotationsListeners.clear();
  }
}
