export const SCAN_INTERVAL_MS      = 900;
export const CONSECUTIVE_MATCHES   = 2;
export const COOLDOWN_MS           = 3500;
export const REVIEW_THRESHOLD      = 0.8;
export const MIN_CORNER_CONFIDENCE = 0.02;
export const CORNER_OVERLAY_COLOUR = '#22c55e';

export const WORKER_FILENAME = 'scanner.worker.mjs';

import type { CardScannerGame } from './types';

export const GAME_OPTIONS: { value: CardScannerGame; label: string }[] = [
  { value: 'magic',    label: 'Magic' },
  { value: 'pokemon',  label: 'Pokémon' },
  { value: 'lorcana',  label: 'Lorcana' },
  { value: 'onepiece', label: 'One Piece' },
];

