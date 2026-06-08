import { InjectionToken } from '@angular/core';

/**
 * Base path for CollectorVision static assets: worker script, manifests, sounds.
 *
 * Defaults to `collectorvision` (relative — resolves against the document base URL,
 * so it works correctly both at the root domain and under a subdirectory such as
 * GitHub Pages). Override with an absolute path or CDN URL when needed:
 * ```ts
 * providers: [{ provide: CV_ASSET_BASE_PATH, useValue: 'https://cdn.example.com/cv' }]
 * ```
 */
export const CV_ASSET_BASE_PATH = new InjectionToken<string>('CV_ASSET_BASE_PATH', {
  providedIn: 'root',
  factory: () => 'collectorvision',
});
