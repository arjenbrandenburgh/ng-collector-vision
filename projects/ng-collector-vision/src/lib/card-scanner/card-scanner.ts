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

  /** Number of consecutive matching frames required before emitting `cardDetected`. Default 2. */
  readonly consecutiveMatches = input<number>(CONSECUTIVE_MATCHES);

  /** Cooldown in ms before the same card can be detected again. Default 3500. */
  readonly cooldownMs = input<number>(COOLDOWN_MS);

  /** Group alternate printings of the same card by secondary ID (oracle ID). Default true. */
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
  readonly #wasmBase  = inject(CV_WASM_BASE_PATH);

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

    // Restart when game changes while the scanner is active.
    effect(() => {
      this.game();
      untracked(() => {
        if (this.status() !== 'idle') void this.openScanner();
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
    const manifestUrl = `${this.#assetBase}/assets/${this.game()}/manifest.json`;
    let manifest: unknown;
    try {
      const res = await fetch(manifestUrl, { signal: this.#abortCtrl.signal });
      if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
      manifest = await res.json();
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
      const video = this.videoEl()?.nativeElement;
      if (video) {
        video.srcObject = this.#stream;
        await video.play();
      }
      if (this.playSounds()) {
        this.#audioCtx = new AudioContext();
        void this.#preloadSounds();
      }
    } catch {
      this.#setError('Camera access denied. Allow camera permissions and try again.');
      return;
    }

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
        wasmBase:  this.#wasmBase,
        enableWebGpu: false,
        minCornerConfidence: this.minCornerConfidence(),
      });
    } catch {
      this.#setError('Failed to start the scanner worker.');
    }
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
        this.#startScanLoop();
        this.#startPreviewLoop();
        break;
      case 'result':
        this.#workerBusy = false;
        this.#lastResult = msg;
        this.cornerConfidence.set(msg.confidence);
        this.#handleFrameResult(msg);
        break;
      case 'error':
        this.#workerBusy = false;
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

  #emit(confirmed: ConfirmedResult): void {
    const needsReview = confirmed.score < REVIEW_THRESHOLD;
    const detection: CardDetection = {
      cardId: confirmed.cardId,
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
  }

  #setError(message: string): void {
    this.#teardown();
    this.status.set('error');
    this.errorMessage.set(message);
  }
}
