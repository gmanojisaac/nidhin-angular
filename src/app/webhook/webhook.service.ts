import { Injectable, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable, shareReplay } from 'rxjs';

export type WebhookPayload = {
  symbol?: string;
  stoppx?: number;
  intent?: string;
  side?: string;
  ALTERNATE_SIGNAL?: string;
  BUY_SELL_SELL?: string;
  SELL_BUY_BUY?: string;
  raw?: unknown;
};

@Injectable({ providedIn: 'root' })
export class WebhookService implements OnDestroy {
  private readonly socket: Socket;
  readonly webhook$: Observable<WebhookPayload>;

  constructor() {
    this.socket = io('http://localhost:3001');

    this.socket.on('connect', () => {
      console.log('[webhook] socket connected', this.socket.id);
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('[webhook] socket disconnected', reason);
    });

    this.socket.on('connect_error', (error) => {
      console.error('[webhook] socket connect error', error);
    });

    this.webhook$ = new Observable<WebhookPayload>((subscriber) => {
      const handler = (payload: WebhookPayload) => {
        try {
          console.log(`[webhook] payload received ${JSON.stringify(payload)}`);
        } catch {
          console.log('[webhook] payload received [unserializable payload]');
        }
        subscriber.next(payload);
      };
      this.socket.on('webhook', handler);
      return () => this.socket.off('webhook', handler);
    }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
  }

  ngOnDestroy(): void {
    this.socket.disconnect();
  }
}
