import initWasm, * as wasmExports from '../wasm/pkg/edf_core.js';
import { EdfEngine } from '../lib/engine/EdfEngine.js';
import type {
  Annotation,
  ScanProgress,
  WasmModule,
} from '../lib/engine/types.js';
import type {
  WorkerInMessage,
  WorkerOutMessage,
} from '../lib/engine/protocol.js';

let wasmInitialized = false;
let engine: EdfEngine | null = null;
let currentFile: File | null = null;
let scanAbortController: AbortController | null = null;
let latestViewRequestId = 0;

async function ensureWasm(): Promise<WasmModule> {
  if (!wasmInitialized) {
    await initWasm();
    wasmInitialized = true;
  }
  return wasmExports as unknown as WasmModule;
}

// ---------------------------------------------------------------------------
// IndexedDB Overview Cache Helpers
// ---------------------------------------------------------------------------

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('edf-viewer', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('overview')) {
        db.createObjectStore('overview');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getIdbOverview(key: string): Promise<Uint8Array | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openIdb();
    return new Promise((resolve) => {
      const tx = db.transaction('overview', 'readonly');
      const store = tx.objectStore('overview');
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result && req.result instanceof Uint8Array) {
          resolve(req.result);
        } else if (req.result && req.result.buffer instanceof ArrayBuffer) {
          resolve(new Uint8Array(req.result.buffer));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function putIdbOverview(key: string, data: Uint8Array): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openIdb();
    return new Promise((resolve) => {
      const tx = db.transaction('overview', 'readwrite');
      const store = tx.objectStore('overview');
      store.put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB write failures
  }
}

// ---------------------------------------------------------------------------
// Background Scan Runner
// ---------------------------------------------------------------------------

function startBackgroundScan(file: File, cacheKey: string) {
  if (!engine) return;

  scanAbortController?.abort();
  scanAbortController = new AbortController();
  const signal = scanAbortController.signal;

  engine
    .scan(
      (progress: ScanProgress) => {
        const msg: WorkerOutMessage = { type: 'progress', progress };
        self.postMessage(msg);
      },
      signal,
      (annots: Annotation[]) => {
        const msg: WorkerOutMessage = {
          type: 'annotations',
          items: annots,
          done: false,
        };
        self.postMessage(msg);
      }
    )
    .then(async () => {
      if (!engine || signal.aborted) return;
      const allAnnots = engine.getAnnotations();
      const doneMsg: WorkerOutMessage = {
        type: 'annotations',
        items: allAnnots,
        done: true,
      };
      self.postMessage(doneMsg);

      try {
        const overviewBytes = engine.exportOverview();
        await putIdbOverview(cacheKey, overviewBytes);
      } catch {
        // Silently ignore cache store failure
      }
    })
    .catch((err) => {
      if (!signal.aborted) {
        console.warn('Background overview scan failed:', err);
      }
    });
}

// ---------------------------------------------------------------------------
// Worker Message Dispatch
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'open': {
      try {
        const wasm = await ensureWasm();
        currentFile = msg.file;
        engine = new EdfEngine(currentFile, wasm);
        const header = await engine.open();

        const cacheKey = `${currentFile.name}|${currentFile.size}|${currentFile.lastModified}|v1`;

        // Check IndexedDB overview cache first
        const cachedOverview = await getIdbOverview(cacheKey);
        if (cachedOverview) {
          try {
            engine.importOverview(cachedOverview);
          } catch {
            // Bad cached bytes: restart scan
            startBackgroundScan(currentFile, cacheKey);
          }
        } else {
          // Auto-start background scan for overview & annotations
          startBackgroundScan(currentFile, cacheKey);
        }

        const res: WorkerOutMessage = {
          id: msg.id,
          type: 'open_result',
          header,
        };
        self.postMessage(res);
      } catch (err) {
        const res: WorkerOutMessage = {
          id: msg.id,
          type: 'open_result',
          error: String(err),
        };
        self.postMessage(res);
      }
      break;
    }

    case 'view': {
      const reqId = msg.id;
      latestViewRequestId = reqId;

      if (!engine) {
        const res: WorkerOutMessage = {
          id: reqId,
          type: 'view_result',
          error: 'No EDF file opened',
        };
        self.postMessage(res);
        return;
      }

      try {
        const result = await engine.getView(msg.req);

        // Check if superseded by a newer view request (latest-view-wins)
        if (reqId !== latestViewRequestId) {
          const res: WorkerOutMessage = {
            id: reqId,
            type: 'view_result',
            stale: true,
          };
          self.postMessage(res);
          return;
        }

        // Collect Float32Array buffers for zero-copy transferable transfer
        const transferables: ArrayBuffer[] = [];
        for (const ch of result.channels) {
          if (ch.values && ch.values.buffer instanceof ArrayBuffer) {
            transferables.push(ch.values.buffer);
          }
        }

        const res: WorkerOutMessage = {
          id: reqId,
          type: 'view_result',
          result,
        };
        self.postMessage(res, { transfer: transferables });
      } catch (err) {
        if (reqId === latestViewRequestId) {
          const res: WorkerOutMessage = {
            id: reqId,
            type: 'view_result',
            error: String(err),
          };
          self.postMessage(res);
        }
      }
      break;
    }

    case 'spectrogram': {
      const reqId = msg.id;
      if (!engine) {
        const res: WorkerOutMessage = {
          id: reqId,
          type: 'spectrogram_result',
          error: 'No EDF file opened',
        };
        self.postMessage(res);
        return;
      }

      try {
        const result = await engine.getSpectrogram(msg.req);
        const transferables: ArrayBuffer[] = [];
        if (result.power_db instanceof Float32Array && result.power_db.buffer instanceof ArrayBuffer) {
          transferables.push(result.power_db.buffer);
        }
        const res: WorkerOutMessage = {
          id: reqId,
          type: 'spectrogram_result',
          result,
        };
        self.postMessage(res, { transfer: transferables });
      } catch (err) {
        const res: WorkerOutMessage = {
          id: reqId,
          type: 'spectrogram_result',
          error: String(err),
        };
        self.postMessage(res);
      }
      break;
    }

    case 'prefetch': {
      if (engine) {
        engine.prefetch(msg.t0, msg.t1).catch(() => {});
      }
      break;
    }

    case 'scan': {
      if (engine && currentFile) {
        const cacheKey = `${currentFile.name}|${currentFile.size}|${currentFile.lastModified}|v1`;
        startBackgroundScan(currentFile, cacheKey);
      }
      break;
    }

    case 'cancelScan': {
      scanAbortController?.abort();
      scanAbortController = null;
      break;
    }

    case 'close': {
      scanAbortController?.abort();
      scanAbortController = null;
      if (engine) {
        engine.close();
        engine = null;
      }
      currentFile = null;
      const res: WorkerOutMessage = {
        id: msg.id,
        type: 'close_result',
      };
      self.postMessage(res);
      break;
    }

    default:
      break;
  }
};
