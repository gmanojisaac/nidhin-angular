import { Injectable, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable, shareReplay } from 'rxjs';

export type BinancePayload = {
  exchange?: string;
  symbol?: string;
  price?: number;
  timestamp?: string | number;
  raw?: unknown;
};

@Injectable({ providedIn: 'root' })
export class BinanceService implements OnDestroy {
  private readonly socket: Socket;
  readonly binance$: Observable<BinancePayload>;

  constructor() {
    this.socket = io('http://localhost:3002');

    this.socket.on('connect', () => {
      console.log('[binance] socket connected', this.socket.id);
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('[binance] socket disconnected', reason);
    });

    this.socket.on('connect_error', (error) => {
      console.error('[binance] socket connect error', error);
    });

    this.binance$ = new Observable<BinancePayload>((subscriber) => {
      const handler = (payload: BinancePayload) => {
        subscriber.next(payload);
      };
      this.socket.on('binance:ws', handler);
      return () => this.socket.off('binance:ws', handler);
    }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
  }

  ngOnDestroy(): void {
    this.socket.disconnect();
  }
}
