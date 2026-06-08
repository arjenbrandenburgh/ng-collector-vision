/** TCG game families supported by CollectorVision. */
export type CardScannerGame = 'magic' | 'pokemon' | 'lorcana' | 'onepiece';

// ── Worker message types ────────────────────────────────────────────────────
// These mirror the actual messages emitted by scanner.worker.mjs.

export interface WorkerProgressMsg {
  type: 'progress';
  stage: 'webgpu' | 'dewarp' | 'detector' | 'embedder' | 'catalog';
  ratio: number;
  loaded?: number;
  total?: number;
  cached?: boolean;
  inferenceMode?: 'WebGPU' | 'WASM';
}

export interface WorkerReadyMsg {
  type: 'ready';
  inferenceMode: 'WebGPU' | 'WASM';
  numThreads: number;
  catalogRows: number;
  catalogTotalRows: number;
  catalogLimit: number | null;
}

export interface WorkerResultMsg {
  type: 'result';
  cardPresent: boolean;
  cornersValid: boolean;
  /** Normalised corner coordinates [[x, y], ...] in range [0, 1]. */
  corners?: [number, number][];
  confidence: number;
  sharpness?: number | null;
  cardId?: string | null;
  secondaryId?: string | null;
  secondaryIdField?: string | null;
  score?: number | null;
  orientation?: 'upright' | 'rotated_180' | null;
  timing?: Record<string, number>;
}

export interface WorkerErrorMsg {
  type: 'error';
  message: string;
}

export type WorkerMsg = WorkerProgressMsg | WorkerReadyMsg | WorkerResultMsg | WorkerErrorMsg;

/** A confirmed multi-frame match returned by `ConfirmationBucket.push()`. */
export type ConfirmedResult = WorkerResultMsg & { cardId: string; score: number };

// ── Public detection event ──────────────────────────────────────────────────

/**
 * A confirmed card detection emitted by `CardScannerComponent`.
 *
 * Contains exactly what the CollectorVision worker + confirmation bucket
 * produce — no enrichment. Consumers (e.g. a demo app) call Scryfall,
 * TCGplayer, or their own catalog API to resolve a name, image, or price.
 */
export interface CardDetection {
  /** Raw card identifier from the CollectorVision catalog (e.g. Scryfall UUID). */
  cardId: string;
  /** Oracle ID or other secondary identifier, if the catalog includes one. */
  secondaryId: string | null;
  /** Name of the `secondaryId` field (e.g. `"oracleId"`). */
  secondaryIdField: string | null;
  /** Cosine similarity score, range [0, 1]. */
  score: number;
  /** Corner-detector confidence value. */
  confidence: number;
  /** Normalised corner coordinates [[x, y], ...] in [0, 1]. */
  corners: [number, number][];
  /** Sharpness estimate from the model, if available. */
  sharpness: number | null;
  /** Orientation detected by the embedder. */
  orientation: 'upright' | 'rotated_180' | null;
  /** True when `score` is below `REVIEW_THRESHOLD` — consumer should flag for review. */
  needsReview: boolean;
  /** ISO 8601 timestamp of the detection. */
  detectedAt: string;
}

/** Lifecycle states of the scanner. */
export type ScannerStatus =
  | 'idle'
  | 'requesting-permission'
  | 'downloading'
  | 'scanning'
  | 'error';
