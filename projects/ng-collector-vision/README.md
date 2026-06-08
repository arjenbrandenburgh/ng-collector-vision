# ng-collector-vision

> Angular 22 component library for real-time, on-device TCG card scanning — powered by [CollectorVision](https://github.com/HanClinto/CollectorVision).

Point a camera at a Magic: The Gathering, Pokémon, Lorcana, or One Piece card. Get back a card identity in under a second. **No server. No API key. No cloud.**

```html
<cv-card-scanner game="magic" (cardDetected)="onCard($event)" />
```

[![npm version](https://img.shields.io/npm/v/%40cybey%2Fng-collector-vision.svg)](https://www.npmjs.com/package/@cybey/ng-collector-vision)
[![license: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](https://github.com/HanClinto/CollectorVision/blob/main/LICENSE)

**[Live demo →](https://arjenbrandenburgh.github.io/ng-collector-vision/)**

---

## What is CollectorVision?

This library is an Angular wrapper around **[CollectorVision](https://github.com/HanClinto/CollectorVision)** — an open-source card-recognition library created by [@HanClinto](https://github.com/HanClinto).

CollectorVision solves a hard computer vision problem: given a hand-held photo of a trading card (arbitrary angle, lighting, sleeve), identify the exact printing. It does this with two custom-trained ONNX neural networks:

| Model         | Role            | Input                   | Output                                |
| ------------- | --------------- | ----------------------- | ------------------------------------- |
| **Cornelius** | Corner detector | 384 × 384 video frame   | 4 corner points + presence confidence |
| **Milo**      | Card embedder   | 448 × 448 dewarped crop | 128-dimensional fingerprint           |

The fingerprint is matched against a catalog of ~108 k reference embeddings (cosine similarity, <10 ms on device). Catalogs are published as versioned `.npz` snapshots on [HuggingFace (HanClinto/milo)](https://huggingface.co/HanClinto/milo/tree/main/catalogs) and cached in IndexedDB after the first download.

**The full pipeline runs end-to-end in the browser, in a Web Worker, with no data ever leaving the device.**

Try the original web demo: **https://hanclinto.github.io/CollectorVision/**

---

## How the Angular wrapper adds value

CollectorVision ships a plain JavaScript Web Worker and applet. `ng-collector-vision` wraps it in a production-ready Angular component that:

- Manages the camera stream lifecycle (permissions, play/pause, teardown)
- Drives the scan loop at a configurable interval
- Runs the confirmation bucket (N consecutive frames must agree before emitting)
- Handles the full async init sequence: manifest → getUserMedia → worker → ready
- Exposes everything as typed Angular signals and outputs
- Synthesises audio feedback via WebAudio (no asset files required by default)
- Provides CSS custom properties for theming
- Emits `cardDetected` with SSR safety, abort handling, and correct cleanup on destroy

---

## Installation

```bash
npm install @cybey/ng-collector-vision
```

### 1 — Copy runtime assets (`angular.json`)

The package ships the CollectorVision Web Worker, ONNX WASM runtime, and a Cross-Origin Isolation service worker. Add them to your application's `angular.json` assets:

```json
"assets": [
  {
    "glob": "**/*",
    "input": "node_modules/ng-collector-vision/collectorvision",
    "output": "/collectorvision"
  },
  {
    "glob": "coi-serviceworker.js",
    "input": "node_modules/ng-collector-vision/collectorvision",
    "output": "/"
  }
]
```

> **Why?** The inference pipeline runs in a `Web Worker` using multi-threaded WASM (`SharedArrayBuffer`). `SharedArrayBuffer` requires [Cross-Origin Isolation](https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated) — the included service worker injects the required `COOP`/`COEP` headers on every same-origin response so this works on any static host.

### 2 — Register the service worker (`index.html`)

Add this **before** the Angular bootstrap `<script>` tag:

```html
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('coi-serviceworker.js').then((reg) => {
      if (reg.installing) {
        reg.installing.addEventListener('statechange', (e) => {
          if (e.target.state === 'activated') location.reload();
        });
      }
    });
  }
</script>
```

On the first page load the service worker installs, claims the page, and triggers one reload so the page runs under the isolation headers. All subsequent visits are seamless and instant.

> **Note:** Use a relative path (`coi-serviceworker.js`, no leading `/`) so the registration works both at the root domain and under a subdirectory (e.g. GitHub Pages).

### 3 — Add game manifests

For each game you want to scan, create a JSON manifest at:

```
public/collectorvision/assets/<game>/manifest.json
```

The manifest tells the worker where to find the ONNX models and which HuggingFace catalog to load:

```json
{
  "version": "2026-05-07",
  "models": {
    "cornelius": "https://hanclinto.github.io/CollectorVision/assets/models/cornelius.onnx",
    "milo": "https://hanclinto.github.io/CollectorVision/assets/models/milo.onnx"
  },
  "catalog": {
    "huggingface_key": "tcgplayer-mtg",
    "dims": 128,
    "rows": 0
  }
}
```

**Available catalogs** (from [HanClinto/milo on HuggingFace](https://huggingface.co/HanClinto/milo/tree/main/catalogs)):

| Game                 | `huggingface_key`    | Card ID format        |
| -------------------- | -------------------- | --------------------- |
| Magic: The Gathering | `tcgplayer-mtg`      | TCGplayer integer IDs |
| Pokémon TCG          | `tcgplayer-pokemon`  | TCGplayer integer IDs |
| Disney Lorcana       | `tcgplayer-lorcana`  | TCGplayer integer IDs |
| One Piece Card Game  | `tcgplayer-onepiece` | TCGplayer integer IDs |

Models (~10 MB combined) and catalogs (~1–53 MB depending on game) download once and are cached in IndexedDB. Subsequent launches are instant, even offline.

### 4 — Provide HTTP client

```ts
// app.config.ts
import { provideHttpClient } from '@angular/common/http';

export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient()],
};
```

---

## Quick start

```ts
// my-scanner.component.ts
import { Component } from '@angular/core';
import { CardScannerComponent, type CardDetection } from '@cybey/ng-collector-vision';

@Component({
  selector: 'app-my-scanner',
  imports: [CardScannerComponent],
  template: `
    <cv-card-scanner
      game="magic"
      (cardDetected)="onCard($event)"
      (scannerClosed)="isOpen = false"
    />
  `,
})
export class MyScannerComponent {
  isOpen = true;

  onCard(detection: CardDetection): void {
    // detection.cardId is a TCGplayer integer ID (for tcgplayer-* catalogs)
    // or a Scryfall UUID (for scryfall-* catalogs)
    console.log(detection.cardId, detection.score.toFixed(3));
  }
}
```

---

## Component API

### Selector

```html
<cv-card-scanner … />
```

### Inputs

| Input                 | Type              | Default      | Description                                                                                                                                  |
| --------------------- | ----------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `game`                | `CardScannerGame` | **required** | Active game. Changing this value restarts the scanner.                                                                                       |
| `minCornerConfidence` | `number`          | `0.02`       | Cornelius gate threshold `[0–1]`. Raise to reduce false positives in cluttered scenes. Updated live — no restart required.                   |
| `minAcceptanceScore`  | `number`          | `0.5`        | Minimum Milo cosine similarity before a frame is passed to the confirmation bucket `[0–1]`. Updated live.                                    |
| `consecutiveMatches`  | `number`          | `2`          | Number of consecutive matching frames required before `cardDetected` fires. Higher = more certain, slower. Updated live.                     |
| `cooldownMs`          | `number`          | `3500`       | Cooldown (ms) before the same card can fire `cardDetected` again. Updated live.                                                              |
| `groupBySecondaryId`  | `boolean`         | `true`       | When `true`, alternate printings of the same card (same oracle/secondary ID) are grouped together for the confirmation streak. Updated live. |
| `scanIntervalMs`      | `number`          | `900`        | Interval between frame captures (ms). Minimum `100` recommended. Updated live.                                                               |
| `playSounds`          | `boolean`         | `true`       | Enable synthesized audio feedback.                                                                                                           |
| `confidentSoundUrl`   | `string \| null`  | `null`       | WAV (or any Web Audio–decodable format) for a confident detection. `null` → synthesized two-note chime.                                      |
| `uncertainSoundUrl`   | `string \| null`  | `null`       | Sound for a low-confidence detection. `null` → synthesized blip.                                                                             |

`CardScannerGame`:

```ts
type CardScannerGame = 'magic' | 'pokemon' | 'lorcana' | 'onepiece';
```

### Outputs

| Output          | Payload         | When                                                                                      |
| --------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `cardDetected`  | `CardDetection` | Every confirmed detection (after streak + cooldown).                                      |
| `scannerClosed` | `void`          | When `close()` is called, or when the component is destroyed while the scanner is active. |

### Public signals (read-only)

| Signal             | Type                                 | Description                                                              |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------ |
| `status`           | `ScannerStatus`                      | Current lifecycle state (see below).                                     |
| `downloadProgress` | `number`                             | Download progress `[0–100]` during the `'downloading'` phase.            |
| `errorMessage`     | `string`                             | Human-readable error message when `status() === 'error'`.                |
| `cornerConfidence` | `number`                             | Latest Cornelius confidence value from the worker (updated every frame). |
| `viewfinderFlash`  | `'confident' \| 'uncertain' \| null` | Active viewfinder ring animation.                                        |
| `isScanning`       | `computed`                           | `true` when `status() === 'scanning'`.                                   |

### Methods

| Method          | Description                                                           |
| --------------- | --------------------------------------------------------------------- |
| `openScanner()` | Start (or restart) the scanner. Called automatically on mount.        |
| `close()`       | Stop camera and worker, set status to `'idle'`, emit `scannerClosed`. |

### `ScannerStatus`

```ts
type ScannerStatus =
  | 'idle' // Not started, or after close()
  | 'requesting-permission' // Waiting for the browser camera permission prompt
  | 'downloading' // Fetching models + catalog (shows download progress)
  | 'scanning' // Live — will emit cardDetected
  | 'error'; // Unrecoverable. Read errorMessage(). Call openScanner() to retry.
```

### `CardDetection`

```ts
interface CardDetection {
  /** Raw card identifier from the CollectorVision catalog.
   *  TCGplayer catalogs → integer string  e.g. "507371"
   *  Scryfall catalogs  → UUID            e.g. "abc123-..." */
  cardId: string;

  /** Oracle ID or other secondary identifier, if the catalog includes one. */
  secondaryId: string | null;

  /** Name of the secondaryId field, e.g. "oracleId". */
  secondaryIdField: string | null;

  /** Cosine similarity score [0, 1]. Values ≥ 0.8 are high-confidence. */
  score: number;

  /** Cornelius corner-detector confidence for this frame. */
  confidence: number;

  /** Normalised corner coordinates [[x, y], ...] in [0, 1]. */
  corners: [number, number][];

  /** Milo sharpness estimate, if the model provides it. */
  sharpness: number | null;

  /** Card orientation detected by Milo. */
  orientation: 'upright' | 'rotated_180' | null;

  /** True when score < 0.8. Consumer should flag the card for manual review. */
  needsReview: boolean;

  /** ISO 8601 timestamp of the detection. */
  detectedAt: string;
}
```

---

## Theming

The component renders only the raw viewfinder (video + canvas overlay). Status text, error messages, flash rings, and all other chrome are the consumer's responsibility — use the public signals to drive your own UI.

### Adding a flash ring

Use `viewfinderFlash` (read via a template reference) to apply your own animation:

```html
<div
  class="scanner-wrap"
  [class.flash-confident]="scanner.viewfinderFlash() === 'confident'"
  [class.flash-uncertain]="scanner.viewfinderFlash() === 'uncertain'"
>
  <cv-card-scanner #scanner game="magic" (cardDetected)="onCard($event)" />
</div>
```

```css
@keyframes ring-confident {
  0% {
    box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.9);
  }
  100% {
    box-shadow: 0 0 0 4px rgba(34, 197, 94, 0);
  }
}
@keyframes ring-uncertain {
  0% {
    box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.9);
  }
  100% {
    box-shadow: 0 0 0 4px rgba(245, 158, 11, 0);
  }
}
.scanner-wrap {
  border-radius: 12px;
}
.flash-confident {
  animation: ring-confident 0.9s ease-out forwards;
}
.flash-uncertain {
  animation: ring-uncertain 0.9s ease-out forwards;
}
```

---

## Handling detections

### Deduplication and quantity tracking

`cardDetected` fires once per confirmation streak — the built-in cooldown (default 3.5 s) prevents rapid re-fires. Consumer code is responsible for maintaining a list:

```ts
protected readonly cards = signal<CardDetection[]>([]);

onCard(detection: CardDetection): void {
  this.cards.update(list => {
    const i = list.findIndex(c => c.cardId === detection.cardId);
    // Re-scan of the same card after cooldown — increment quantity in your own model
    if (i >= 0) return list; // or increment a counter
    return [detection, ...list];
  });
}
```

### Enriching with Scryfall (Magic)

For Magic cards scanned with the `tcgplayer-mtg` catalog, `cardId` is a TCGplayer integer ID. Scryfall can resolve it:

```ts
fetch(`https://api.scryfall.com/cards/tcgplayer/${detection.cardId}`)
  .then((r) => r.json())
  .then((card) => console.log(card.name, card.image_uris?.small));
```

For the `scryfall-mtg` catalog, `cardId` is directly a Scryfall UUID:

```ts
fetch(`https://api.scryfall.com/cards/${detection.cardId}`)
  .then((r) => r.json())
  .then((card) => console.log(card.name));
```

### Handling the `needsReview` flag

```html
@if (detection.needsReview) {
<span class="warning">Low confidence — please verify this card visually.</span>
}
```

### Showing the scanner status

```html
@switch (scanner.status()) { @case ('requesting-permission') {
<p>Please allow camera access in your browser.</p>
} @case ('downloading') {
<p>Loading… {{ scanner.downloadProgress() }}%</p>
} @case ('error') {
<p class="error">{{ scanner.errorMessage() }}</p>
<button (click)="scanner.openScanner()">Retry</button>
} }
```

Where `scanner` is a `viewChild(CardScannerComponent)` reference.

---

## Advanced configuration

### Asset base path

`CV_ASSET_BASE_PATH` controls where game manifests and sound files are fetched from. Override to serve these from your own platform or CDN:

```ts
import { CV_ASSET_BASE_PATH } from '@cybey/ng-collector-vision';

providers: [{ provide: CV_ASSET_BASE_PATH, useValue: 'https://platform.example.com' }];
```

> **Note:** `scanner.worker.mjs` and its bundled vendor files always load from the **local** origin — cross-origin workers require explicit `Access-Control-Allow-Origin` headers that most servers don't provide. `CV_ASSET_BASE_PATH` does not control the worker path.

### Cloudflare Pages and hosts with a per-file size limit

The bundled ONNX Runtime WASM binary (`ort-wasm-simd-threaded.asyncify.wasm`) is ~27 MB, which exceeds Cloudflare Pages' per-file limit. Redirect it to a CDN using the pre-built constant:

```ts
import { CV_WASM_BASE_PATH, ORT_CDN_WASM_PATH } from '@cybey/ng-collector-vision';

providers: [{ provide: CV_WASM_BASE_PATH, useValue: ORT_CDN_WASM_PATH }];
```

`ORT_CDN_WASM_PATH` points to `onnxruntime-web@1.24.3` on jsDelivr. Alternatively, use your own R2 bucket or any URL that serves the WASM with correct `Content-Type: application/wasm` headers:

```ts
providers: [{ provide: CV_WASM_BASE_PATH, useValue: 'https://pub-xxx.r2.dev/wasm/' }];
```

The WASM file remains in the npm package for hosts that can serve it locally — `CV_WASM_BASE_PATH` is purely opt-in.

### Custom sounds

Replace the synthesized WebAudio tones with your own WAV files:

```html
<cv-card-scanner
  game="magic"
  confidentSoundUrl="/sounds/pickup_high.wav"
  uncertainSoundUrl="/sounds/scan.wav"
  (cardDetected)="onCard($event)"
/>
```

### Silent mode

```html
<cv-card-scanner game="magic" [playSounds]="false" (cardDetected)="onCard($event)" />
```

### Tuning the scanner

All tuning parameters update live without restarting the worker or camera:

```html
<cv-card-scanner
  game="magic"
  [minCornerConfidence]="0.05"
  [minAcceptanceScore]="0.6"
  [consecutiveMatches]="3"
  [cooldownMs]="5000"
  [scanIntervalMs]="500"
  [groupBySecondaryId]="false"
  (cardDetected)="onCard($event)"
/>
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ cv-card-scanner (Angular component)                  │
│                                                       │
│  Camera (getUserMedia)                               │
│    │ every scanIntervalMs                            │
│    ▼                                                  │
│  canvas.drawImage(video)                             │
│    │ createImageBitmap()  [transferred]              │
│    ▼                                                  │
│  scanner.worker.mjs  ◄─── manifest.json             │
│  ┌─────────────────┐       models + catalog         │
│  │ Cornelius (ONNX)│  384×384 → corners             │
│  │ Dewarp          │  perspective transform          │
│  │ Milo (ONNX)     │  448×448 → 128-d embedding     │
│  │ Cosine search   │  embedding × catalog            │
│  └────────┬────────┘                                 │
│           │ WorkerResultMsg { cardId, score, ... }   │
│           ▼                                          │
│  ConfirmationBucket (N consecutive matches)          │
│           │ confirmed                                │
│           ▼                                          │
│  cardDetected.emit(CardDetection)                    │
└─────────────────────────────────────────────────────┘
```

**First-launch latency:** models download once (~10 MB) and catalog downloads once (1–53 MB depending on game), both cached in IndexedDB. Cold start is the only slow path.

**Steady-state latency:** <100 ms per inference on a mid-range laptop CPU (WASM SIMD, multi-threaded).

---

## Browser support

Requires:

- `getUserMedia` (camera access)
- Web Workers with ES modules
- `createImageBitmap`
- `SharedArrayBuffer` + Cross-Origin Isolation (provided by the bundled service worker)
- IndexedDB (for model/catalog caching)

Tested on: Chrome 120+, Firefox 121+, Safari 17+, Android Chrome.

---

## License

**AGPL-3.0** — see [LICENSE](https://github.com/your-org/ng-collector-vision/blob/main/LICENSE).

This package bundles assets from [CollectorVision](https://github.com/HanClinto/CollectorVision) (AGPL-3.0, by [@HanClinto](https://github.com/HanClinto)). Commercial use of the underlying models may require a separate license — see the CollectorVision repository for details.

The bundled `onnxruntime-web` WASM runtime is licensed under the MIT License.
