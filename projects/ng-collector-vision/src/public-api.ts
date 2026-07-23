/*
 * Public API Surface of ng-collector-vision
 */

// Main component
export { CardScannerComponent } from './lib/card-scanner/card-scanner';

// Types
export type {
  CardScannerGame,
  CardDetection,
  ScannerStatus,
  WorkerMsg,
  WorkerProgressMsg,
  WorkerReadyMsg,
  WorkerResultMsg,
  WorkerErrorMsg,
  ConfirmedResult,
  ImageScanFailureReason,
  ImageScanOutcome,
} from './lib/types';

// Asset base path token
export { CV_ASSET_BASE_PATH, CV_WASM_BASE_PATH, ORT_CDN_WASM_PATH } from './lib/tokens';

// Internal utilities exposed for advanced consumers
export { ConfirmationBucket } from './lib/confirmation-bucket';
export {
  GAME_OPTIONS,
  SCAN_INTERVAL_MS,
  CONSECUTIVE_MATCHES,
  COOLDOWN_MS,
  REVIEW_THRESHOLD,
  MIN_CORNER_CONFIDENCE,
} from './lib/constants';
