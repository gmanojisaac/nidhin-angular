import { Injectable, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { defer, from, merge, Observable, share, shareReplay, take } from 'rxjs';

export type Tick = unknown;

@Injectable({ providedIn: 'root' })
export class TickService implements OnDestroy {
  private readonly socket: Socket;
  private readonly liveTicks$: Observable<Tick>;
  private readonly cacheKey = 'tick-cache-latest';

  readonly ticks$: Observable<Tick>;
  readonly firstTick$: Observable<Tick>;

  constructor() {
    this.socket = io('http://localhost:3002');

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

    this.liveTicks$ = liveTicks$.pipe(share());

    this.ticks$ = defer(() => merge(from(this.readCache()), this.liveTicks$));
    this.firstTick$ = this.ticks$.pipe(
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
      if (!this.isMarketOpen()) {
        const existing = this.readCache();
        if (existing.length >= ticks.length) {
          return;
        }
      }
      localStorage.setItem(this.cacheKey, JSON.stringify(ticks));
    } catch {
      // Ignore cache errors (quota, unsupported, etc.).
    }
  }

  private isMarketOpen(now: Date = new Date()): boolean {
    const parts = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(now);
    const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
    const isWeekend = weekday === 'Sat' || weekday === 'Sun';
    if (isWeekend) {
      return false;
    }
    const minutes = hour * 60 + minute;
    const openAt = 9 * 60 + 15;
    const closeAt = 15 * 60 + 30;
    return minutes >= openAt && minutes <= closeAt;
  }
}

