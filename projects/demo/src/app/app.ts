import { Component, DestroyRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import {
  CardScannerComponent,
  CONSECUTIVE_MATCHES,
  COOLDOWN_MS,
  GAME_OPTIONS,
  MIN_CORNER_CONFIDENCE,
  SCAN_INTERVAL_MS,
  type CardDetection,
  type CardScannerGame,
} from 'ng-collector-vision';

import { ScryfallService } from './scryfall.service';

/** A detection enriched with Scryfall metadata, plus a running quantity. */
export interface EnrichedCard {
  detection: CardDetection;
  quantity: number;
  name: string;
  setName: string;
  setCode: string;
  thumbnailUrl: string | null;
  loading: boolean;
}

@Component({
  selector: 'app-root',
  imports: [CardScannerComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly #scryfall = inject(ScryfallService);
  readonly #destroyRef = inject(DestroyRef);

  // ── Scanner reference (for accessing status, flash, etc. from the template) ──

  protected readonly scanner = viewChild(CardScannerComponent);

  // ── Game picker ───────────────────────────────────────────────────────────

  protected readonly gameOptions = GAME_OPTIONS;
  protected readonly selectedGame = signal<CardScannerGame>('magic');

  // ── Scanner settings ──────────────────────────────────────────────────────

  protected readonly cornerThreshold = signal(MIN_CORNER_CONFIDENCE); // 0.02
  protected readonly idThreshold = signal(0.5);
  protected readonly consecutiveScans = signal(CONSECUTIVE_MATCHES); // 2
  protected readonly scanInterval = signal(SCAN_INTERVAL_MS); // 900
  protected readonly cooldown = signal(COOLDOWN_MS); // 3500
  protected readonly groupBySecondary = signal(true);

  // ── Card list ─────────────────────────────────────────────────────────────

  protected readonly cards = signal<EnrichedCard[]>([]);
  protected readonly recentId = signal<string | null>(null);
  protected readonly scannerOpen = signal(true);

  protected readonly totalCount = computed(() => this.cards().reduce((n, c) => n + c.quantity, 0));

  // ── Card detection ────────────────────────────────────────────────────────

  protected onCardDetected(detection: CardDetection): void {
    const existing = this.cards().find((c) => c.detection.cardId === detection.cardId);

    if (existing) {
      this.cards.update((list) =>
        list.map((c) =>
          c.detection.cardId === detection.cardId
            ? { ...c, quantity: c.quantity + 1, detection }
            : c,
        ),
      );
      this.#triggerFlash(detection.cardId);
      return;
    }

    const placeholder: EnrichedCard = {
      detection,
      quantity: 1,
      name: detection.cardId,
      setName: '',
      setCode: '',
      thumbnailUrl: null,
      loading: true,
    };
    this.cards.update((list) => [placeholder, ...list]);
    this.#triggerFlash(detection.cardId);

    this.#scryfall
      .lookup(detection.cardId)
      .pipe(takeUntilDestroyed(this.#destroyRef))
      .subscribe((sf) => {
        this.cards.update((list) =>
          list.map((c) =>
            c.detection.cardId === detection.cardId
              ? {
                  ...c,
                  loading: false,
                  name: sf.name || detection.cardId,
                  setName: sf.set_name || '',
                  setCode: sf.set?.toUpperCase() || '',
                  thumbnailUrl: ScryfallService.thumbnail(sf),
                }
              : c,
          ),
        );
      });
  }

  // ── Game + scanner controls ───────────────────────────────────────────────

  protected selectGame(game: CardScannerGame): void {
    if (game === this.selectedGame()) return;
    this.selectedGame.set(game);
    this.cards.set([]);
  }

  protected onScannerClosed(): void {
    this.scannerOpen.set(false);
  }
  protected openScanner(): void {
    this.scannerOpen.set(true);
  }

  // ── Card list mutations ───────────────────────────────────────────────────

  protected increment(card: EnrichedCard): void {
    this.cards.update((list) =>
      list.map((c) =>
        c.detection.cardId === card.detection.cardId ? { ...c, quantity: c.quantity + 1 } : c,
      ),
    );
  }

  protected decrement(card: EnrichedCard): void {
    this.cards.update((list) =>
      list
        .map((c) =>
          c.detection.cardId === card.detection.cardId ? { ...c, quantity: c.quantity - 1 } : c,
        )
        .filter((c) => c.quantity > 0),
    );
  }

  protected remove(card: EnrichedCard): void {
    this.cards.update((list) => list.filter((c) => c.detection.cardId !== card.detection.cardId));
  }

  protected clearAll(): void {
    this.cards.set([]);
  }

  #triggerFlash(cardId: string): void {
    this.recentId.set(cardId);
    setTimeout(() => {
      if (this.recentId() === cardId) this.recentId.set(null);
    }, 800);
  }
}
