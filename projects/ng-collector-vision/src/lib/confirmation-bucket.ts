import type { ConfirmedResult, WorkerResultMsg } from './types';

interface BucketEntry {
  bucketKey: string;
  count: number;
  bestScore: number;
  bestResult: ConfirmedResult;
}

/**
 * Accumulates consecutive frame matches from the scanner worker and emits a
 * confirmed detection only after `consecutiveMatches` frames agree on the same
 * card (or secondary-ID bucket). Ported from collectorvision-scanner-applet.mjs.
 */
export class ConfirmationBucket {
  #consecutiveMatches: number;
  #cooldownMs: number;
  #groupBySecondaryId: boolean;
  #candidate: BucketEntry | null = null;
  #cooldowns = new Map<string, number>();

  constructor(consecutiveMatches: number, cooldownMs: number, groupBySecondaryId: boolean) {
    this.#consecutiveMatches = Math.max(1, consecutiveMatches);
    this.#cooldownMs = Math.max(0, cooldownMs);
    this.#groupBySecondaryId = groupBySecondaryId;
  }

  /** Feed a frame result; returns a confirmed card when the streak is met. */
  push(result: WorkerResultMsg | null): ConfirmedResult | null {
    const now = Date.now();
    for (const [key, expiry] of this.#cooldowns) {
      if (now >= expiry) this.#cooldowns.delete(key);
    }

    if (!result?.cardId || !Number.isFinite(result.score)) {
      if (this.#candidate) {
        this.#candidate.count = Math.max(0, this.#candidate.count - 1);
        if (this.#candidate.count === 0) this.#candidate = null;
      }
      return null;
    }

    const bucketKey = this.#bucketKey(result as WorkerResultMsg & { cardId: string });
    if (this.#cooldowns.has(bucketKey)) return null;

    if (this.#candidate?.bucketKey === bucketKey) {
      this.#candidate.count++;
      if (result.score! > this.#candidate.bestScore) {
        this.#candidate.bestScore = result.score!;
        this.#candidate.bestResult = result as ConfirmedResult;
      }
    } else {
      this.#candidate = {
        bucketKey,
        count: 1,
        bestScore: result.score!,
        bestResult: result as ConfirmedResult,
      };
    }

    if (this.#candidate.count < this.#consecutiveMatches) return null;

    const confirmed = this.#candidate.bestResult;
    this.#cooldowns.set(bucketKey, now + this.#cooldownMs);
    this.#candidate = null;
    return confirmed;
  }

  reset(): void {
    this.#candidate = null;
    this.#cooldowns.clear();
  }

  #bucketKey(result: WorkerResultMsg & { cardId: string }): string {
    if (this.#groupBySecondaryId && result.secondaryId?.trim()) {
      return `secondary:${result.secondaryId.trim()}`;
    }
    return `card:${result.cardId}`;
  }
}
