import { InjectionToken } from '@angular/core';

/**
 * Base path for CollectorVision dynamic assets: game manifests and audio files.
 *
 * Defaults to `collectorvision` (relative — resolves against the document base
 * URL, so it works at the root domain and under a subdirectory like GitHub Pages).
 *
 * Override to serve manifests and sounds from a CDN:
 * ```ts
 * providers: [{ provide: CV_ASSET_BASE_PATH, useValue: 'https://cdn.example.com/cv' }]
 * ```
 *
 * **Note:** `scanner.worker.mjs` and its bundled vendor files (ONNX Runtime WASM)
 * are always loaded from `collectorvision/` in the app's own origin — Web Workers
 * are same-origin only, and the static `./vendor/` import inside the worker
 * must be co-located with the worker script. This token does not control those paths.
 */
export const CV_ASSET_BASE_PATH = new InjectionToken<string>('CV_ASSET_BASE_PATH', {
  providedIn: 'root',
  factory: () => 'collectorvision',
});
