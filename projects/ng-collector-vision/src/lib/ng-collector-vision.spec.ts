import { TestBed } from '@angular/core/testing';

import { CardScannerComponent } from './card-scanner/card-scanner';
import { ConfirmationBucket } from './confirmation-bucket';
import {
  CONSECUTIVE_MATCHES,
  COOLDOWN_MS,
  GAME_OPTIONS,
  MIN_CORNER_CONFIDENCE,
  REVIEW_THRESHOLD,
  SCAN_INTERVAL_MS,
} from './constants';
import { CV_ASSET_BASE_PATH } from './tokens';
import type { WorkerResultMsg } from './types';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeResult(
  cardId: string,
  score: number,
  overrides: Partial<WorkerResultMsg> = {},
): WorkerResultMsg {
  return {
    type: 'result',
    cardPresent: true,
    cornersValid: true,
    confidence: 0.9,
    cardId,
    score,
    ...overrides,
  };
}

// ── ConfirmationBucket ─────────────────────────────────────────────────────

describe('ConfirmationBucket', () => {
  describe('construction', () => {
    it('clamps consecutiveMatches to minimum 1', () => {
      const bucket = new ConfirmationBucket(0, 0, false);
      // A single push should immediately confirm with clamped value of 1.
      const result = bucket.push(makeResult('card-a', 0.9));
      expect(result).not.toBeNull();
    });

    it('clamps cooldownMs to minimum 0', () => {
      const bucket = new ConfirmationBucket(1, -500, false);
      bucket.push(makeResult('card-a', 0.9)); // confirm
      // Immediately pushing the same card should be allowed (0 ms cooldown already expired).
      vi.useFakeTimers();
      vi.advanceTimersByTime(1);
      const result = bucket.push(makeResult('card-a', 0.9));
      expect(result).not.toBeNull();
      vi.useRealTimers();
    });
  });

  describe('confirmation streak', () => {
    it('returns null until consecutiveMatches frames agree', () => {
      const bucket = new ConfirmationBucket(3, 0, false);
      expect(bucket.push(makeResult('card-a', 0.9))).toBeNull();
      expect(bucket.push(makeResult('card-a', 0.9))).toBeNull();
      expect(bucket.push(makeResult('card-a', 0.9))).not.toBeNull();
    });

    it('returns the confirmed result on the Nth matching frame', () => {
      const bucket = new ConfirmationBucket(2, 0, false);
      bucket.push(makeResult('card-a', 0.85));
      const confirmed = bucket.push(makeResult('card-a', 0.92));
      expect(confirmed?.cardId).toBe('card-a');
    });

    it('confirms immediately with consecutiveMatches = 1', () => {
      const bucket = new ConfirmationBucket(1, 0, false);
      const result = bucket.push(makeResult('card-a', 0.9));
      expect(result).not.toBeNull();
      expect(result?.cardId).toBe('card-a');
    });

    it('decays the streak by 1 when a null frame arrives (not a full reset)', () => {
      const bucket = new ConfirmationBucket(3, 0, false);
      // Build count to 2.
      bucket.push(makeResult('card-a', 0.9)); // count: 0→1
      bucket.push(makeResult('card-a', 0.9)); // count: 1→2
      // Null frame decrements by 1 → count: 2→1.
      bucket.push(null);
      // Only 2 more frames needed (1→2, 2→3=confirm), not 3.
      expect(bucket.push(makeResult('card-a', 0.9))).toBeNull(); // count: 1→2
      expect(bucket.push(makeResult('card-a', 0.9))).not.toBeNull(); // count: 2→3 → confirms
    });

    it('fully clears the candidate when null frames decay the count to 0', () => {
      const bucket = new ConfirmationBucket(3, 0, false);
      bucket.push(makeResult('card-a', 0.9)); // count: 0→1
      bucket.push(null); // count: 1→0 → candidate nulled
      // Candidate is gone; a new streak starts from scratch.
      expect(bucket.push(makeResult('card-a', 0.9))).toBeNull(); // count: 0→1
      expect(bucket.push(makeResult('card-a', 0.9))).toBeNull(); // count: 1→2
      expect(bucket.push(makeResult('card-a', 0.9))).not.toBeNull(); // count: 2→3 → confirms
    });

    it('handles null push on an empty bucket without throwing', () => {
      const bucket = new ConfirmationBucket(2, 0, false);
      expect(() => bucket.push(null)).not.toThrow();
    });

    it('replaces the candidate when a different card is seen', () => {
      const bucket = new ConfirmationBucket(2, 0, false);
      bucket.push(makeResult('card-a', 0.9));
      // card-b appears — should reset to a new candidate.
      expect(bucket.push(makeResult('card-b', 0.9))).toBeNull();
      expect(bucket.push(makeResult('card-b', 0.9))).not.toBeNull();
    });

    it('rejects frames with no cardId', () => {
      const bucket = new ConfirmationBucket(1, 0, false);
      const result = bucket.push({ ...makeResult('card-a', 0.9), cardId: null });
      expect(result).toBeNull();
    });

    it('rejects frames with non-finite score', () => {
      const bucket = new ConfirmationBucket(1, 0, false);
      expect(bucket.push({ ...makeResult('card-a', 0.9), score: NaN })).toBeNull();
      expect(bucket.push({ ...makeResult('card-a', 0.9), score: Infinity })).toBeNull();
      expect(bucket.push({ ...makeResult('card-a', 0.9), score: undefined })).toBeNull();
    });

    it("accepts score = 0 (boundary — filtering is the component's job)", () => {
      const bucket = new ConfirmationBucket(1, 0, false);
      const result = bucket.push(makeResult('card-a', 0));
      expect(result).not.toBeNull();
      expect(result?.score).toBe(0);
    });
  });

  describe('bestScore tracking', () => {
    it('keeps the result with the highest score in the streak', () => {
      const bucket = new ConfirmationBucket(3, 0, false);
      const low = makeResult('card-a', 0.7);
      const high = makeResult('card-a', 0.95);
      const mid = makeResult('card-a', 0.8);
      bucket.push(low);
      bucket.push(high);
      const confirmed = bucket.push(mid);
      // high scored 0.95 — should be the confirmed result.
      expect(confirmed?.score).toBe(0.95);
    });

    it('does not downgrade bestResult when a lower-scored frame arrives', () => {
      const bucket = new ConfirmationBucket(2, 0, false);
      bucket.push(makeResult('card-a', 0.95));
      const confirmed = bucket.push(makeResult('card-a', 0.6));
      expect(confirmed?.score).toBe(0.95);
    });
  });

  describe('cooldown', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('suppresses the same card during cooldown', () => {
      const bucket = new ConfirmationBucket(1, 1000, false);
      bucket.push(makeResult('card-a', 0.9)); // confirms + sets cooldown
      // Immediately pushing again during cooldown should return null.
      expect(bucket.push(makeResult('card-a', 0.9))).toBeNull();
    });

    it('allows re-confirmation after cooldown expires', () => {
      const bucket = new ConfirmationBucket(1, 1000, false);
      bucket.push(makeResult('card-a', 0.9));
      vi.advanceTimersByTime(1001);
      const result = bucket.push(makeResult('card-a', 0.9));
      expect(result).not.toBeNull();
    });

    it("does not block a different card during another card's cooldown", () => {
      const bucket = new ConfirmationBucket(1, 1000, false);
      bucket.push(makeResult('card-a', 0.9));
      const result = bucket.push(makeResult('card-b', 0.9));
      expect(result).not.toBeNull();
    });
  });

  describe('groupBySecondaryId', () => {
    it('groups by secondaryId when enabled', () => {
      const bucket = new ConfirmationBucket(2, 0, true);
      const r1 = makeResult('card-a', 0.9, { secondaryId: 'oracle-x' });
      const r2 = makeResult('card-b', 0.85, { secondaryId: 'oracle-x' });
      // Both share oracle-x — should build a streak together.
      bucket.push(r1);
      const confirmed = bucket.push(r2);
      expect(confirmed).not.toBeNull();
    });

    it('treats cards with the same cardId but different secondaryId as different when enabled', () => {
      const bucket = new ConfirmationBucket(2, 0, true);
      bucket.push(makeResult('card-a', 0.9, { secondaryId: 'oracle-1' }));
      // Different oracle — resets.
      expect(bucket.push(makeResult('card-a', 0.9, { secondaryId: 'oracle-2' }))).toBeNull();
    });

    it('falls back to cardId grouping when secondaryId is absent', () => {
      const bucket = new ConfirmationBucket(2, 0, true);
      bucket.push(makeResult('card-a', 0.9, { secondaryId: undefined }));
      const confirmed = bucket.push(makeResult('card-a', 0.9, { secondaryId: undefined }));
      expect(confirmed).not.toBeNull();
    });

    it('uses cardId when groupBySecondaryId is false even with secondaryId present', () => {
      const bucket = new ConfirmationBucket(2, 0, false);
      // Same oracle but different cardId — should NOT group.
      bucket.push(makeResult('card-a', 0.9, { secondaryId: 'oracle-x' }));
      expect(bucket.push(makeResult('card-b', 0.9, { secondaryId: 'oracle-x' }))).toBeNull();
    });
  });

  describe('reset()', () => {
    it('clears an in-progress candidate', () => {
      const bucket = new ConfirmationBucket(3, 0, false);
      bucket.push(makeResult('card-a', 0.9));
      bucket.push(makeResult('card-a', 0.9));
      bucket.reset();
      // After reset, needs 3 fresh frames again.
      expect(bucket.push(makeResult('card-a', 0.9))).toBeNull();
    });

    it('clears active cooldowns', () => {
      const bucket = new ConfirmationBucket(1, 9999, false);
      bucket.push(makeResult('card-a', 0.9)); // confirms + sets long cooldown
      bucket.reset();
      // Cooldown should be gone.
      const result = bucket.push(makeResult('card-a', 0.9));
      expect(result).not.toBeNull();
    });
  });
});

// ── CardScannerComponent ───────────────────────────────────────────────────

describe('CardScannerComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CardScannerComponent],
    }).compileComponents();
  });

  function createScanner(game: 'magic' | 'pokemon' | 'lorcana' | 'onepiece' = 'magic') {
    const fixture = TestBed.createComponent(CardScannerComponent);
    fixture.componentRef.setInput('game', game);
    // Do NOT call fixture.detectChanges() — afterNextRender would try to open
    // the scanner (fetch manifest, getUserMedia, new Worker), none of which
    // are available in the JSDOM test environment.
    return fixture.componentInstance;
  }

  describe('initial signal state', () => {
    it('status starts as idle', () => {
      expect(createScanner().status()).toBe('idle');
    });

    it('downloadProgress starts at 0', () => {
      expect(createScanner().downloadProgress()).toBe(0);
    });

    it('errorMessage starts empty', () => {
      expect(createScanner().errorMessage()).toBe('');
    });

    it('cornerConfidence starts at 0', () => {
      expect(createScanner().cornerConfidence()).toBe(0);
    });

    it('viewfinderFlash starts as null', () => {
      expect(createScanner().viewfinderFlash()).toBeNull();
    });

    it('isScanning() is false when idle', () => {
      expect(createScanner().isScanning()).toBe(false);
    });
  });

  describe('input defaults', () => {
    it('minCornerConfidence defaults to MIN_CORNER_CONFIDENCE', () => {
      expect(createScanner().minCornerConfidence()).toBe(MIN_CORNER_CONFIDENCE);
    });

    it('minAcceptanceScore defaults to 0.5', () => {
      expect(createScanner().minAcceptanceScore()).toBe(0.5);
    });

    it('consecutiveMatches defaults to CONSECUTIVE_MATCHES', () => {
      expect(createScanner().consecutiveMatches()).toBe(CONSECUTIVE_MATCHES);
    });

    it('cooldownMs defaults to COOLDOWN_MS', () => {
      expect(createScanner().cooldownMs()).toBe(COOLDOWN_MS);
    });

    it('groupBySecondaryId defaults to true', () => {
      expect(createScanner().groupBySecondaryId()).toBe(true);
    });

    it('scanIntervalMs defaults to SCAN_INTERVAL_MS', () => {
      expect(createScanner().scanIntervalMs()).toBe(SCAN_INTERVAL_MS);
    });

    it('playSounds defaults to true', () => {
      expect(createScanner().playSounds()).toBe(true);
    });

    it('confidentSoundUrl defaults to null', () => {
      expect(createScanner().confidentSoundUrl()).toBeNull();
    });

    it('uncertainSoundUrl defaults to null', () => {
      expect(createScanner().uncertainSoundUrl()).toBeNull();
    });
  });

  describe('game input', () => {
    it('accepts all supported game values', () => {
      for (const game of ['magic', 'pokemon', 'lorcana', 'onepiece'] as const) {
        const comp = createScanner(game);
        expect(comp.game()).toBe(game);
      }
    });

    it('reflects a custom input value', () => {
      const comp = createScanner('pokemon');
      expect(comp.game()).toBe('pokemon');
    });
  });

  describe('CV_ASSET_BASE_PATH token', () => {
    it('uses the provided asset base path', () => {
      TestBed.overrideProvider(CV_ASSET_BASE_PATH, { useValue: '/custom/path' });
      const fixture = TestBed.createComponent(CardScannerComponent);
      fixture.componentRef.setInput('game', 'magic');
      // The token is injected — component creates without throwing.
      expect(fixture.componentInstance).toBeTruthy();
    });
  });
});

// ── Constants ──────────────────────────────────────────────────────────────

describe('constants', () => {
  it('GAME_OPTIONS covers all four supported games', () => {
    const values = GAME_OPTIONS.map((o) => o.value);
    expect(values).toContain('magic');
    expect(values).toContain('pokemon');
    expect(values).toContain('lorcana');
    expect(values).toContain('onepiece');
    expect(values).not.toContain('riftbound');
    expect(GAME_OPTIONS).toHaveLength(4);
  });

  it('REVIEW_THRESHOLD is between 0 and 1', () => {
    expect(REVIEW_THRESHOLD).toBeGreaterThan(0);
    expect(REVIEW_THRESHOLD).toBeLessThan(1);
  });

  it('SCAN_INTERVAL_MS is a positive number', () => {
    expect(SCAN_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('CONSECUTIVE_MATCHES is at least 1', () => {
    expect(CONSECUTIVE_MATCHES).toBeGreaterThanOrEqual(1);
  });

  it('COOLDOWN_MS is positive', () => {
    expect(COOLDOWN_MS).toBeGreaterThan(0);
  });

  it('MIN_CORNER_CONFIDENCE is between 0 and 1', () => {
    expect(MIN_CORNER_CONFIDENCE).toBeGreaterThanOrEqual(0);
    expect(MIN_CORNER_CONFIDENCE).toBeLessThan(1);
  });
});
