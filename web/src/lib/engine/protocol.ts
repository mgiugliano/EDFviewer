import type {
  Annotation,
  EdfHeaderInfo,
  ScanProgress,
  SpectrogramRequest,
  SpectrogramResult,
  ViewRequest,
  ViewResult,
} from './types.js';

// Worker incoming requests (Client -> Worker)
export interface OpenRequestMsg {
  id: number;
  type: 'open';
  file: File;
}

export interface ViewRequestMsg {
  id: number;
  type: 'view';
  req: ViewRequest;
}

export interface PrefetchRequestMsg {
  type: 'prefetch';
  t0: number;
  t1: number;
}

export interface ScanRequestMsg {
  type: 'scan';
}

export interface CancelScanRequestMsg {
  type: 'cancelScan';
}

export interface CloseRequestMsg {
  id: number;
  type: 'close';
}

export interface SpectrogramRequestMsg {
  id: number;
  type: 'spectrogram';
  req: SpectrogramRequest;
}

export type WorkerInMessage =
  | OpenRequestMsg
  | ViewRequestMsg
  | SpectrogramRequestMsg
  | PrefetchRequestMsg
  | ScanRequestMsg
  | CancelScanRequestMsg
  | CloseRequestMsg;

// Worker outgoing responses (Worker -> Client)
export interface OpenResponseMsg {
  id: number;
  type: 'open_result';
  header?: EdfHeaderInfo;
  error?: string;
}

export interface ViewResponseMsg {
  id: number;
  type: 'view_result';
  result?: ViewResult;
  stale?: boolean;
  error?: string;
}

export interface SpectrogramResponseMsg {
  id: number;
  type: 'spectrogram_result';
  result?: SpectrogramResult;
  stale?: boolean;
  error?: string;
}

export interface ProgressMsg {
  type: 'progress';
  progress: ScanProgress;
}

export interface AnnotationsMsg {
  type: 'annotations';
  items: Annotation[];
  done: boolean;
}

export interface CloseResponseMsg {
  id: number;
  type: 'close_result';
}

export interface WorkerErrorMsg {
  id?: number;
  type: 'error';
  message: string;
}

export type WorkerOutMessage =
  | OpenResponseMsg
  | ViewResponseMsg
  | SpectrogramResponseMsg
  | ProgressMsg
  | AnnotationsMsg
  | CloseResponseMsg
  | WorkerErrorMsg;
