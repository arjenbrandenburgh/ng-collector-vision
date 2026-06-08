import { InjectionToken } from '@angular/core';

/**
 * Base path for CollectorVision static assets: worker script, manifests, sounds.
 *
 * Defaults to `/collectorvision`. Override if you serve assets from a CDN:
 * ```ts
 * providers: [{ provide: CV_ASSET_BASE_PATH, useValue: 'https://cdn.example.com/cv' }]
 * ```
 */
export const CV_ASSET_BASE_PATH = new InjectionToken<string>('CV_ASSET_BASE_PATH', {
  providedIn: 'root',
  factory: () => '/collectorvision',
});
