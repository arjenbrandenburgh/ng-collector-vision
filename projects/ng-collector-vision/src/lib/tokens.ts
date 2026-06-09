import { InjectionToken } from '@angular/core';

/**
 * Base path for CollectorVision dynamic assets: game manifests and audio files.
 *
 * Defaults to `collectorvision` (relative — resolves against the document base
 * URL, so it works at the root domain and under a subdirectory like GitHub Pages).
 *
 * Override to serve manifests from a platform or CDN:
 * ```ts
 * providers: [{ provide: CV_ASSET_BASE_PATH, useValue: 'https://platform.example.com' }]
 * ```
 *
 * Note: `scanner.worker.mjs` and its vendor files always load from the local
 * origin — cross-origin workers require explicit CORS headers from the host,
 * which most servers do not provide.
 */
export const CV_ASSET_BASE_PATH = new InjectionToken<string>('CV_ASSET_BASE_PATH', {
  providedIn: 'root',
  factory: () => 'collectorvision',
});

/**
 * Base URL from which onnxruntime-web loads the WASM binary
 * (`ort-wasm-simd-threaded.asyncify.wasm`, ~27 MB).
 *
 * Defaults to `null` — ort-web resolves the WASM relative to its own `.mjs`
 * file (the locally bundled vendor directory). Fine for most hosts.
 *
 * **Cloudflare Pages / any host with a per-file size limit:**
 * ```ts
 * import { CV_WASM_BASE_PATH, ORT_CDN_WASM_PATH } from '@hippolink/ng-collector-vision';
 *
 * providers: [{ provide: CV_WASM_BASE_PATH, useValue: ORT_CDN_WASM_PATH }]
 * ```
 *
 * Or point at your own R2 bucket / storage:
 * ```ts
 * providers: [{ provide: CV_WASM_BASE_PATH, useValue: 'https://r2.example.com/wasm/' }]
 * ```
 */
export const CV_WASM_BASE_PATH = new InjectionToken<string | null>('CV_WASM_BASE_PATH', {
  providedIn: 'root',
  factory: () => null,
});

/**
 * jsDelivr CDN path for onnxruntime-web 1.24.3 WASM files.
 * Use with `CV_WASM_BASE_PATH` when you cannot host the 27 MB binary locally.
 */
export const ORT_CDN_WASM_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
