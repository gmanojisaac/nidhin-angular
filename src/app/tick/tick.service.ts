import { Injectable, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { from, merge, Observable, share, shareReplay, take } from 'rxjs';

export type Tick = unknown;

@Injectable({ providedIn: 'root' })
export class TickService implements OnDestroy {
  private readonly socket: Socket;
  private readonly tickStream$: Observable<Tick>;
  private readonly cacheKey = 'tick-cache-latest';

  readonly ticks$: Observable<Tick>;
  readonly firstTick$: Observable<Tick>;

  constructor() {
    this.socket = io('http://localhost:3001');

    this.socket.on('connect', () => {
      console.log('[tick] socket connected', this.socket.id);
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('[tick] socket disconnected', reason);
    });

    this.socket.on('connect_error', (error) => {
      console.error('[tick] socket connect error', error);
    });

    const liveTicks$ = new Observable<Tick>((subscriber) => {
      const handler = (ticks: Tick[] | Tick) => {
        if (Array.isArray(ticks)) {
          this.writeCache(ticks);
          for (const tick of ticks) {
            subscriber.next(tick);
          }
          return;
        }
        this.writeCache([ticks]);
        subscriber.next(ticks);
      };
      this.socket.on('ticks', handler);
      return () => this.socket.off('ticks', handler);
    });

    const cachedTicks$ = from(this.readCache());

    this.tickStream$ = merge(cachedTicks$, liveTicks$).pipe(share());

    this.ticks$ = this.tickStream$;
    this.firstTick$ = this.tickStream$.pipe(
      take(1),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  clearCache(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.removeItem(this.cacheKey);
    } catch {
      // Ignore cache errors (quota, unsupported, etc.).
    }
  }

  ngOnDestroy(): void {
    this.socket.disconnect();
  }

  private readCache(): Tick[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }
    try {
      const raw = localStorage.getItem(this.cacheKey);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeCache(ticks: Tick[]): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(this.cacheKey, JSON.stringify(ticks));
    } catch {
      // Ignore cache errors (quota, unsupported, etc.).
    }
  }
}

