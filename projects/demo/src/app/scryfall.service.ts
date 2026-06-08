import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, of, tap } from 'rxjs';

export interface ScryfallCard {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  tcgplayer_id?: number | null;
  prices?: { usd?: string | null; usd_foil?: string | null };
  image_uris?: { small?: string; normal?: string; art_crop?: string };
  card_faces?: Array<{ image_uris?: { small?: string; normal?: string } }>;
}

const NULL_CARD: ScryfallCard = {
  id: '',
  name: '',
  set: '',
  set_name: '',
  collector_number: '',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thin Scryfall API wrapper for the demo application.
 * Handles both Scryfall UUID card IDs and TCGplayer integer IDs.
 * Caches results in memory so repeated scans never hit the network twice.
 */
@Injectable({ providedIn: 'root' })
export class ScryfallService {
  readonly #http = inject(HttpClient);
  readonly #cache = new Map<string, ScryfallCard>();

  lookup(cardId: string): Observable<ScryfallCard> {
    const hit = this.#cache.get(cardId);
    if (hit) return of(hit);

    const url = UUID_RE.test(cardId)
      ? `https://api.scryfall.com/cards/${cardId}`
      : `https://api.scryfall.com/cards/tcgplayer/${cardId}`;

    return this.#http.get<ScryfallCard>(url).pipe(
      tap((card) => this.#cache.set(cardId, card)),
      catchError(() => of(NULL_CARD)),
    );
  }

  /** Convenience: small thumbnail URL from a ScryfallCard. */
  static thumbnail(card: ScryfallCard): string | null {
    return card.image_uris?.small ?? card.card_faces?.[0]?.image_uris?.small ?? null;
  }
}
