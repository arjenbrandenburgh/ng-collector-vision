import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { ConfirmationBucket } from '../confirmation-bucket';
import {
  CONSECUTIVE_MATCHES,
  COOLDOWN_MS,
  CORNER_OVERLAY_COLOUR,
  MAX_IMAGE_LONG_EDGE_PX,
  MIN_CORNER_CONFIDENCE,
  REVIEW_THRESHOLD,
  SCAN_INTERVAL_MS,
  WORKER_FILENAME,
} from '../constants';
import { CV_ASSET_BASE_PATH, CV_WASM_BASE_PATH } from '../tokens';
import type {
  CardDetection,
  CardScannerGame,
  ConfirmedResult,
  ImageScanOutcome,
  ScannerStatus,
  WorkerMsg,
  WorkerResultMsg,
} from '../types';

/**
 * Camera-based card scanner powered by CollectorVision.
 *
 * Renders a viewfinder and emits `cardDetected` for every confirmed detection.
 * No chrome — the consumer owns all surrounding UI.
 *
 * Changing the `game` input restarts the scanner automatically.
 * All other inputs update live without restarting.
 *
 * Also supports scanning still images (e.g. uploaded files) via `scanImage()`,
 * which runs the same detector/embedder pipeline against a single bitmap
 * instead of a live camera stream. Use `pauseCamera()`/`resumeCamera()` to
 * switch between live and still-image modes without tearing down the worker.
 *
 * ### Quick start
 * ```html
 * <cv-card-scanner game="magic" (cardDetected)="onCard($event)" />
 * ```
 */
@Component({
  selector: 'cv-card-scanner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  templateUrl: './card-scanner.html',
  styleUrl: './card-scanner.scss',
  host: { class: 'cv-scanner-host' },
})
export class CardScannerComponent {
  // ── Inputs ────────────────────────────────────────────────────────────────

  readonly game = input.required<CardScannerGame>();

  /** Minimum corner-detector confidence to consider a card present [0–1]. Default 0.02. */
  readonly minCornerConfidence = input<number>(MIN_CORNER_CONFIDENCE);

  /** Minimum embedding similarity score to pass a frame to the confirmation bucket [0–1]. Default 0.5. */
  readonly minAcceptanceScore = input<number>(0.5);

  /** Score below which a confirmed detection is flagged `needsReview` [0–1]. Default 0.8. */
  readonly reviewThreshold = input<number>(REVIEW_THRESHOLD);

  /** Number of consecutive matching frames required before emitting `cardDetected`. Default 2. */
  readonly consecutiveMatches = input<number>(CONSECUTIVE_MATCHES);

  /** Cooldown in ms before the same card can be detected again. Default 3500. */
  readonly cooldownMs = input<number>(COOLDOWN_MS);

  /** Group Scryfall printings by Oracle ID. Current TCGplayer catalogs fall back to card ID. */
  readonly groupBySecondaryId = input<boolean>(true);

  /** Interval between frame captures in ms. Default 900. */
  readonly scanIntervalMs = input<number>(SCAN_INTERVAL_MS);

  /** Enable audio feedback on each scan. Set `false` for silent mode. */
  readonly playSounds = input<boolean>(true);

  /** WAV URL for confident-scan feedback. `null` → synthesized chime. */
  readonly confidentSoundUrl = input<string | null>(null);

  /** WAV URL for uncertain-scan feedback. `null` → synthesized blip. */
  readonly uncertainSoundUrl = input<string | null>(null);

  // ── Outputs ───────────────────────────────────────────────────────────────

  /** Emitted for every confirmed detection (after consecutive-match streak + cooldown). */
  readonly cardDetected = output<CardDetection>();
  /** Emitted when `close()` is called programmatically. */
  readonly scannerClosed = output<void>();

  // ── Services ──────────────────────────────────────────────────────────────

  readonly #assetBase = inject(CV_ASSET_BASE_PATH);
  readonly #wasmBase = inject(CV_WASM_BASE_PATH);

  // ── Signals ───────────────────────────────────────────────────────────────

  readonly status = signal<ScannerStatus>('idle');
  readonly downloadProgress = signal<number>(0);
  readonly errorMessage = signal<string>('');
  readonly a11yAnnouncement = signal<string>('');
  readonly viewfinderFlash = signal<'confident' | 'uncertain' | null>(null);
  /** Latest corner-detector confidence value from the worker (updated every frame). */
  readonly cornerConfidence = signal<number>(0);

  readonly isScanning = computed(() => this.status() === 'scanning');

  // ── View refs ─────────────────────────────────────────────────────────────

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoEl');
  private readonly overlayCanvas = viewChild<ElementRef<HTMLCanvasElement>>('overlayCanvas');

  // ── Pipeline state ────────────────────────────────────────────────────────

  // Initialized in afterNextRender to avoid SSR crash (document is unavailable on the server).
  #captureCanvas: HTMLCanvasElement | null = null;
  #captureCtx: CanvasRenderingContext2D | null = null;

  #worker: Worker | null = null;
  #stream: MediaStream | null = null;
  #abortCtrl: AbortController | null = null;
  #scanTimer: ReturnType<typeof setInterval> | null = null;
  #previewFrame: number | null = null;
  #workerReady = false;
  #workerBusy = false;
  #lastResult: WorkerResultMsg | null = null;
  #bucket = new ConfirmationBucket(CONSECUTIVE_MATCHES, COOLDOWN_MS, true);
  #audioCtx: AudioContext | null = null;
  #audioBuffers = new Map<'confident' | 'uncertain', AudioBuffer>();

  // ── Still-image scanning state ───────────────────────────────────────────
  #pendingImageScan: {
    resolve: (outcome: ImageScanOutcome) => void;
    reject: (err: Error) => void;
  } | null = null;
  #imageScanChain: Promise<unknown> | null = null;
  #workerInitPromise: Promise<void> | null = null;
  #workerReadyResolve: (() => void) | null = null;
  #pauseRequested = false;

  #closed = false;

  constructor() {
    // Emit scannerClosed if the component is destroyed while the scanner is active
    // (i.e. the consumer toggled @if without calling close()).
    inject(DestroyRef).onDestroy(() => {
      if (this.status() !== 'idle') {
        this.#teardown();
        this.scannerClosed.emit();
      }
      this.#closed = true;
    });
    // DOM setup + initial startup — deferred to avoid SSR crash.
    afterNextRender(() => {
      this.#captureCanvas = document.createElement('canvas');
      this.#captureCtx = this.#captureCanvas.getContext('2d')!;
      void this.openScanner();
    });

    // Restart when game changes while the scanner is active. Every effect()
    // runs once immediately on creation to establish tracking -- that first
    // run is not a genuine change and must be skipped, otherwise it can race
    // a scanImage()-triggered worker init that's already in flight and spawn
    // a second worker.
    let isFirstGameEffectRun = true;
    effect(() => {
      this.game();
      untracked(() => {
        if (isFirstGameEffectRun) {
          isFirstGameEffectRun = false;
          return;
        }
        if (this.status() === 'idle') return;
        if (this.#stream) {
          void this.openScanner();
        } else if (this.#workerReady || this.#workerInitPromise) {
          // Upload mode: re-init the manifest+worker for the new game
          // without requesting the camera.
          void this.#restartForImages();
        }
      });
    });

    // Send updated corner threshold to worker without restarting.
    effect(() => {
      const mcc = this.minCornerConfidence();
      untracked(() => {
        if (this.#workerReady) {
          this.#worker?.postMessage({ type: 'config', minCornerConfidence: mcc });
        }
      });
    });

    // Restart scan timer when scan interval changes.
    effect(() => {
      const ms = this.scanIntervalMs();
      untracked(() => {
        if (this.#scanTimer !== null) {
          clearInterval(this.#scanTimer);
          this.#scanTimer = setInterval(() => void this.#tick(), ms);
        }
      });
    });

    // Recreate confirmation bucket when its params change.
    effect(() => {
      const cm = this.consecutiveMatches();
      const cd = this.cooldownMs();
      const gs = this.groupBySecondaryId();
      untracked(() => {
        this.#bucket = new ConfirmationBucket(cm, cd, gs);
      });
    });
  }

  // ── Scanner lifecycle ─────────────────────────────────────────────────────

  async openScanner(): Promise<void> {
    if (this.#pauseRequested) {
      // The user already committed to upload mode (pauseCamera() ran)
      // before this call got a chance to start -- this only happens for the
      // automatic mount-time call racing a fast switch to upload mode.
      // Bail out without tearing down any in-progress image scan.
      return;
    }
    this.#teardown();
    this.status.set('downloading');
    this.errorMessage.set('');
    this.downloadProgress.set(0);

    // Fresh bucket with current settings.
    this.#bucket = new ConfirmationBucket(
      this.consecutiveMatches(),
      this.cooldownMs(),
      this.groupBySecondaryId(),
    );

    this.#abortCtrl = new AbortController();
    let manifest: unknown;
    try {
      manifest = await this.#fetchManifest(this.#abortCtrl.signal);
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      this.#setError(err instanceof Error ? err.message : 'Failed to load manifest.');
      return;
    }

    this.status.set('requesting-permission');
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (this.#pauseRequested) {
        // User switched to upload mode while the permission prompt was pending.
        this.#stream.getTracks().forEach((t) => t.stop());
        this.#stream = null;
      } else {
        const video = this.videoEl()?.nativeElement;
        if (video) {
          video.srcObject = this.#stream;
          await video.play();
        }
        if (this.playSounds()) {
          this.#audioCtx = new AudioContext();
          void this.#preloadSounds();
        }
      }
    } catch {
      if (this.#pauseRequested) {
        // User already switched to upload mode before the camera resolved --
        // a failed camera attempt must not disturb an in-progress (or
        // already-initialised) image scan session.
        return;
      }
      this.#setError('Camera access denied. Allow camera permissions and try again.');
      return;
    }

    if (this.#pauseRequested) {
      // Switched to upload mode while getUserMedia was pending — a
      // concurrent scanImage() call may have already spawned its own worker
      // via #restartForImages(); don't spawn a second one here.
      return;
    }
    this.#spawnWorker(manifest);
  }

  /** Fetch the CollectorVision manifest for the current `game`. */
  async #fetchManifest(signal?: AbortSignal): Promise<unknown> {
    const manifestUrl = `${this.#assetBase}/assets/${this.game()}/manifest.json`;
    const res = await fetch(manifestUrl, { signal });
    if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
    return res.json();
  }

  /** Spawn (or respawn) the scanner worker and post `init`. Does not await `ready`. */
  #spawnWorker(manifest: unknown): void {
    try {
      this.#worker = new Worker(`collectorvision/${WORKER_FILENAME}`, { type: 'module' });
      this.#worker.addEventListener('message', (e: MessageEvent<WorkerMsg>) =>
        this.#onWorkerMessage(e.data),
      );
      this.#worker.addEventListener('error', (e: ErrorEvent) =>
        this.#setError(e.message || 'Scanner worker error.'),
      );
      this.#worker.postMessage({
        type: 'init',
        manifest,
        assetBase: this.#assetBase,
        wasmBase: this.#wasmBase,
        enableWebGpu: false,
        minCornerConfidence: this.minCornerConfidence(),
      });
    } catch {
      this.#setError('Failed to start the scanner worker.');
    }
  }

  /**
   * Stop the live camera + scan/preview loops without terminating the
   * worker. Use this (not `close()`) when switching to still-image (upload)
   * mode, so `scanImage()` can keep using the already-initialised worker.
   */
  pauseCamera(): void {
    this.#pauseRequested = true;
    if (this.#scanTimer !== null) {
      clearInterval(this.#scanTimer);
      this.#scanTimer = null;
    }
    if (this.#previewFrame !== null) {
      cancelAnimationFrame(this.#previewFrame);
      this.#previewFrame = null;
    }
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#lastResult = null;
    this.cornerConfidence.set(0);
    this.#bucket.reset();
    const video = this.videoEl()?.nativeElement;
    if (video) video.srcObject = null;
    const canvas = this.overlayCanvas()?.nativeElement;
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  /**
   * Re-acquire the camera and resume scanning after `pauseCamera()`. No-op
   * if the camera is already active; call `openScanner()` first if the
   * worker was never initialised.
   */
  async resumeCamera(): Promise<void> {
    this.#pauseRequested = false;
    if (this.#stream) return;
    this.status.set('requesting-permission');
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch {
      this.#setError('Camera access denied. Allow camera permissions and try again.');
      return;
    }
    if (this.#pauseRequested) {
      // User flipped back to upload mode while the permission prompt was pending.
      this.#stream.getTracks().forEach((t) => t.stop());
      this.#stream = null;
      return;
    }
    const video = this.videoEl()?.nativeElement;
    if (video) {
      video.srcObject = this.#stream;
      await video.play();
    }
    this.status.set('scanning');
    if (this.#workerReady) {
      this.#startScanLoop();
      this.#startPreviewLoop();
    }
  }

  /**
   * Analyse a single still image (e.g. from a file upload) using the same
   * detector + embedder pipeline as the live camera view. Does not require
   * `getUserMedia` and must not be called while a live camera session is
   * active — call `pauseCamera()` first.
   *
   * Bypasses `ConfirmationBucket`'s multi-frame streak requirement: a single
   * image IS the confirmation. On success, emits `cardDetected` exactly like
   * a live-camera confirmation (existing consumers need no changes) and
   * resolves `{ ok: true, detection }`. On failure (no card / low score /
   * unreadable file), does NOT emit `cardDetected`; resolves
   * `{ ok: false, reason, message }`.
   *
   * Concurrent calls are queued and processed one at a time — the worker
   * itself only ever processes one frame at a time (mirrors the live
   * `#tick()` `#workerBusy` gate).
   */
  async scanImage(file: File | Blob): Promise<ImageScanOutcome> {
    if (this.#stream) {
      throw new Error(
        'scanImage() cannot run while the live camera is active — call pauseCamera() first.',
      );
    }
    const run = () => this.#scanImageInternal(file);
    const next = (this.#imageScanChain ?? Promise.resolve()).then(run, run);
    this.#imageScanChain = next.catch(() => undefined);
    return next;
  }

  async #scanImageInternal(file: File | Blob): Promise<ImageScanOutcome> {
    await this.#ensureWorkerReadyForImages();
    if (this.status() === 'error') {
      return {
        ok: false,
        reason: 'worker-error',
        message: this.errorMessage() || 'Scanner failed to start.',
      };
    }

    let bitmap: ImageBitmap;
    try {
      // EXIF-correct decode: camera frames never carry EXIF, so this was
      // never needed on the live path, but uploaded JPEGs commonly do.
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      return { ok: false, reason: 'decode-error', message: 'Could not read this image file.' };
    }
    bitmap = await this.#downscaleIfNeeded(bitmap);

    return new Promise<ImageScanOutcome>((resolve, reject) => {
      this.#pendingImageScan = { resolve, reject };
      this.#workerBusy = true;
      try {
        this.#worker!.postMessage({ type: 'frame', bitmap }, [bitmap]);
      } catch (err) {
        this.#pendingImageScan = null;
        this.#workerBusy = false;
        reject(err instanceof Error ? err : new Error('Failed to post frame to worker.'));
      }
    });
  }

  async #downscaleIfNeeded(bitmap: ImageBitmap): Promise<ImageBitmap> {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= MAX_IMAGE_LONG_EDGE_PX) return bitmap;
    const scale = MAX_IMAGE_LONG_EDGE_PX / longest;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return createImageBitmap(canvas);
  }

  /** (Re)initialise the worker for the current `game` without requesting the camera. */
  async #restartForImages(): Promise<void> {
    this.#teardown();
    this.status.set('downloading');
    this.errorMessage.set('');
    this.downloadProgress.set(0);
    let manifest: unknown;
    try {
      manifest = await this.#fetchManifest();
    } catch (err) {
      this.#setError(err instanceof Error ? err.message : 'Failed to load manifest.');
      return;
    }
    await new Promise<void>((resolve) => {
      this.#workerReadyResolve = resolve;
      this.#spawnWorker(manifest);
    });
  }

  async #ensureWorkerReadyForImages(): Promise<void> {
    if (this.#workerReady) return;
    if (!this.#workerInitPromise) {
      this.#workerInitPromise = this.#restartForImages().finally(() => {
        this.#workerInitPromise = null;
      });
    }
    return this.#workerInitPromise;
  }

  /** Stop the scanner and release all resources. Emits `scannerClosed`. */
  close(): void {
    this.#teardown();
    this.status.set('idle');
    if (!this.#closed) this.scannerClosed.emit();
  }

  // ── Worker messages ───────────────────────────────────────────────────────

  #onWorkerMessage(msg: WorkerMsg): void {
    switch (msg.type) {
      case 'progress':
        this.downloadProgress.set(Math.round(msg.ratio * 100));
        break;
      case 'ready':
        this.#workerReady = true;
        this.status.set('scanning');
        if (this.#stream) {
          this.#startScanLoop();
          this.#startPreviewLoop();
        }
        this.#workerReadyResolve?.();
        this.#workerReadyResolve = null;
        break;
      case 'result':
        this.#workerBusy = false;
        if (this.#pendingImageScan) {
          this.#resolveImageScan(msg);
          break;
        }
        this.#lastResult = msg;
        this.cornerConfidence.set(msg.confidence);
        this.#handleFrameResult(msg);
        break;
      case 'error':
        this.#workerBusy = false;
        if (this.#pendingImageScan) {
          const pending = this.#pendingImageScan;
          this.#pendingImageScan = null;
          pending.resolve({ ok: false, reason: 'worker-error', message: msg.message });
          break;
        }
        this.#setError(msg.message);
        break;
    }
  }

  #handleFrameResult(result: WorkerResultMsg): void {
    if (
      !result.cardPresent ||
      !result.cornersValid ||
      !result.cardId ||
      !Number.isFinite(result.score) ||
      result.score! < this.minAcceptanceScore()
    ) {
      this.#bucket.push(null);
      return;
    }
    const confirmed = this.#bucket.push(result);
    if (confirmed) this.#emit(confirmed);
  }

  /**
   * Resolve a single-shot `scanImage()` call directly from one worker
   * result, bypassing `ConfirmationBucket`'s multi-frame streak requirement
   * (a still image only ever produces one result, so the bucket would never
   * confirm it under the live-camera default of `consecutiveMatches`).
   */
  #resolveImageScan(result: WorkerResultMsg): void {
    const pending = this.#pendingImageScan;
    this.#pendingImageScan = null;
    if (!pending) return;
    if (!result.cardPresent || !result.cornersValid) {
      pending.resolve({ ok: false, reason: 'no-card', message: 'No card detected in this image.' });
      return;
    }
    if (
      !result.cardId ||
      !Number.isFinite(result.score) ||
      result.score! < this.minAcceptanceScore()
    ) {
      pending.resolve({
        ok: false,
        reason: 'low-score',
        message: 'Could not identify this card with enough confidence.',
      });
      return;
    }
    const confirmed: ConfirmedResult = { ...result, cardId: result.cardId, score: result.score! };
    const detection = this.#emit(confirmed);
    pending.resolve({ ok: true, detection });
  }

  #emit(confirmed: ConfirmedResult): CardDetection {
    const needsReview = confirmed.score < this.reviewThreshold();
    const detection: CardDetection = {
      cardId: confirmed.cardId,
      catalogKey: confirmed.catalogKey ?? '',
      catalogRowKey: confirmed.catalogRowKey ?? '',
      identifiers: { ...(confirmed.identifiers ?? {}) },
      faceIndex: confirmed.faceIndex ?? 0,
      finishes: [...(confirmed.finishes ?? [])],
      resultIdentifier: confirmed.resultIdentifier ?? '',
      secondaryId: confirmed.secondaryId ?? null,
      secondaryIdField: confirmed.secondaryIdField ?? null,
      score: confirmed.score,
      confidence: confirmed.confidence,
      corners: confirmed.corners ?? [],
      sharpness: confirmed.sharpness ?? null,
      orientation: confirmed.orientation ?? null,
      needsReview,
      detectedAt: new Date().toISOString(),
    };
    const label = needsReview ? 'low confidence — please verify' : 'detected';
    this.a11yAnnouncement.set(`Card ${label}: ${confirmed.cardId}`);
    this.#flash(!needsReview);
    this.cardDetected.emit(detection);
    return detection;
  }

  // ── Scan loop ─────────────────────────────────────────────────────────────

  #startScanLoop(): void {
    this.#scanTimer = setInterval(() => void this.#tick(), this.scanIntervalMs());
  }

  async #tick(): Promise<void> {
    if (!this.#workerReady || this.#workerBusy || !this.#stream) return;
    if (!this.#drawCaptureFrame()) return;
    this.#workerBusy = true;
    try {
      const bitmap = await createImageBitmap(this.#captureCanvas!);
      this.#worker!.postMessage({ type: 'frame', bitmap }, [bitmap]);
    } catch {
      this.#workerBusy = false;
    }
  }

  #drawCaptureFrame(): boolean {
    const video = this.videoEl()?.nativeElement;
    if (!video?.videoWidth || !this.#stream || !this.#captureCanvas || !this.#captureCtx)
      return false;
    this.#resizeCanvases(video);
    this.#captureCtx.drawImage(video, 0, 0, this.#captureCanvas.width, this.#captureCanvas.height);
    return true;
  }

  // ── Preview / overlay loop ────────────────────────────────────────────────

  #startPreviewLoop(): void {
    const render = () => {
      this.#drawOverlay(this.#lastResult);
      this.#previewFrame = this.#stream ? requestAnimationFrame(render) : null;
    };
    this.#previewFrame = requestAnimationFrame(render);
  }

  #drawOverlay(result: WorkerResultMsg | null): void {
    const canvas = this.overlayCanvas()?.nativeElement;
    const video = this.videoEl()?.nativeElement;
    if (!canvas || !video?.videoWidth) return;

    this.#resizeCanvases(video);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!result?.cornersValid || !Array.isArray(result.corners)) return;

    const { width, height } = canvas;
    ctx.save();
    ctx.lineWidth = Math.max(3, width * 0.004);
    ctx.strokeStyle = CORNER_OVERLAY_COLOUR;
    ctx.beginPath();
    result.corners.forEach(([x, y], i) => {
      const px = Math.min(1, Math.max(0, x)) * width;
      const py = Math.min(1, Math.max(0, y)) * height;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  #resizeCanvases(video: HTMLVideoElement): void {
    const { videoWidth: w, videoHeight: h } = video;
    const overlay = this.overlayCanvas()?.nativeElement;
    if (overlay && (overlay.width !== w || overlay.height !== h)) {
      overlay.width = w;
      overlay.height = h;
    }
    if (
      this.#captureCanvas &&
      (this.#captureCanvas.width !== w || this.#captureCanvas.height !== h)
    ) {
      this.#captureCanvas.width = w;
      this.#captureCanvas.height = h;
    }
  }

  // ── Flash + sound ─────────────────────────────────────────────────────────

  #flash(confident: boolean): void {
    const kind = confident ? 'confident' : 'uncertain';
    this.viewfinderFlash.set(kind);
    setTimeout(() => {
      if (this.viewfinderFlash() === kind) this.viewfinderFlash.set(null);
    }, 900);
    this.#playPing(confident);
  }

  async #preloadSounds(): Promise<void> {
    const ctx = this.#audioCtx;
    if (!ctx) return;
    const pairs: [string, string | null][] = [
      ['confident', this.confidentSoundUrl()],
      ['uncertain', this.uncertainSoundUrl()],
    ];
    await Promise.allSettled(
      pairs
        .filter((p): p is [string, string] => p[1] !== null)
        .map(async ([key, url]) => {
          const res = await fetch(url);
          const raw = await res.arrayBuffer();
          // Guard: if teardown ran while we were fetching, ctx is no longer current.
          if (this.#audioCtx !== ctx) return;
          const buffer = await ctx.decodeAudioData(raw);
          if (this.#audioCtx !== ctx) return;
          this.#audioBuffers.set(key as 'confident' | 'uncertain', buffer);
        }),
    );
  }

  #playPing(confident: boolean): void {
    if (!this.playSounds() || !this.#audioCtx) return;
    const ctx = this.#audioCtx;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    const buffer = this.#audioBuffers.get(confident ? 'confident' : 'uncertain');
    if (buffer) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = confident ? 0.55 : 0.35;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
      return;
    }

    if (confident) {
      for (const [i, freq] of [
        [0, 880],
        [1, 1175],
      ] as [number, number][]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = ctx.currentTime + i * 0.08;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.38, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.28);
      }
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 660;
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  #teardown(): void {
    this.#abortCtrl?.abort();
    this.#abortCtrl = null;
    if (this.#scanTimer !== null) {
      clearInterval(this.#scanTimer);
      this.#scanTimer = null;
    }
    if (this.#previewFrame !== null) {
      cancelAnimationFrame(this.#previewFrame);
      this.#previewFrame = null;
    }
    this.#worker?.terminate();
    this.#worker = null;
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#workerReady = false;
    this.#workerBusy = false;
    this.#lastResult = null;
    this.cornerConfidence.set(0);
    this.viewfinderFlash.set(null);
    void this.#audioCtx?.close();
    this.#audioCtx = null;
    this.#audioBuffers.clear();
    const video = this.videoEl()?.nativeElement;
    if (video) video.srcObject = null;
    this.#pendingImageScan?.reject(new Error('Scanner was closed while scanning.'));
    this.#pendingImageScan = null;
    this.#workerInitPromise = null;
    this.#workerReadyResolve = null;
  }

  #setError(message: string): void {
    this.#teardown();
    this.status.set('error');
    this.errorMessage.set(message);
  }
}
