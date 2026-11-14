import type { ViewerAnnotation } from './types.js';

const DB_NAME = 'edf-viewer';
const DB_VERSION = 1;
const STORE_NAME = 'annotations';

// Fallback in-memory cache for SSR / Node tests where IndexedDB is absent
const memoryFallback = new Map<string, ViewerAnnotation[]>();

function getIndexedDB(): IDBFactory | null {
  if (typeof window !== 'undefined' && window.indexedDB) {
    return window.indexedDB;
  }
  if (typeof globalThis !== 'undefined' && (globalThis as any).indexedDB) {
    return (globalThis as any).indexedDB;
  }
  return null;
}

function openDb(): Promise<IDBDatabase> {
  const idb = getIndexedDB();
  if (!idb) {
    return Promise.reject(new Error('IndexedDB not supported in current environment'));
  }

  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Generates the standardized storage key: `${fileName}|${fileSize}|${fileMtime}`
 */
export function makeAnnotationStorageKey(file: {
  name: string;
  size?: number;
  lastModified?: number;
}): string {
  const size = file.size ?? 0;
  const mtime = file.lastModified ?? 0;
  return `${file.name}|${size}|${mtime}`;
}

/**
 * Saves annotations for a specific file key to IndexedDB.
 */
export async function saveAnnotationsToIdb(
  key: string,
  annotations: ViewerAnnotation[]
): Promise<void> {
  if (!getIndexedDB()) {
    memoryFallback.set(key, JSON.parse(JSON.stringify(annotations)));
    return;
  }

  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      // Clone plain objects without Svelte proxies
      const plain = JSON.parse(JSON.stringify(annotations));
      const req = store.put(plain, key);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Failed to save to IndexedDB, using memory fallback:', err);
    memoryFallback.set(key, JSON.parse(JSON.stringify(annotations)));
  }
}

/**
 * Loads annotations for a specific file key from IndexedDB.
 */
export async function loadAnnotationsFromIdb(
  key: string
): Promise<ViewerAnnotation[] | null> {
  if (!getIndexedDB()) {
    const cached = memoryFallback.get(key);
    return cached ? JSON.parse(JSON.stringify(cached)) : null;
  }

  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);

      req.onsuccess = () => {
        const res = req.result;
        if (Array.isArray(res)) {
          resolve(res as ViewerAnnotation[]);
        } else {
          // If not in IDB, check fallback
          const cached = memoryFallback.get(key);
          resolve(cached ? JSON.parse(JSON.stringify(cached)) : null);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Failed to load from IndexedDB, using memory fallback:', err);
    const cached = memoryFallback.get(key);
    return cached ? JSON.parse(JSON.stringify(cached)) : null;
  }
}

/**
 * Clears saved annotations for a specific key from IndexedDB.
 */
export async function clearAnnotationsFromIdb(key: string): Promise<void> {
  memoryFallback.delete(key);
  if (!getIndexedDB()) return;

  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(key);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Failed to clear from IndexedDB:', err);
  }
}

/**
 * Debounce controller for autosaving annotations.
 */
export class AnnotationAutosaver {
  private timer: any = null;
  private pendingKey: string | null = null;
  private pendingAnnotations: ViewerAnnotation[] | null = null;

  constructor(private debounceMs: number = 500) {}

  schedule(key: string, annotations: ViewerAnnotation[]): void {
    this.pendingKey = key;
    this.pendingAnnotations = annotations;

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(async () => {
      await this.flush();
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingKey && this.pendingAnnotations) {
      const key = this.pendingKey;
      const ann = this.pendingAnnotations;
      this.pendingKey = null;
      this.pendingAnnotations = null;
      await saveAnnotationsToIdb(key, ann);
    }
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingKey = null;
    this.pendingAnnotations = null;
  }
}
