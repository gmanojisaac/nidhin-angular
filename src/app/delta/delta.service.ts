import { Injectable, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable, shareReplay } from 'rxjs';

export type DeltaPayload = {
  exchange?: string;
  symbol?: string;
  price?: number;
  timestamp?: string | number;
  raw?: unknown;
};

@Injectable({ providedIn: 'root' })
export class DeltaService implements OnDestroy {
  private readonly socket: Socket;
  readonly delta$: Observable<DeltaPayload>;

  constructor() {
    this.socket = io('http://localhost:3002');

    this.socket.on('connect', () => {
    });

    this.socket.on('disconnect', (reason) => {
    });

    this.socket.on('connect_error', (error) => {
    });

    this.delta$ = new Observable<DeltaPayload>((subscriber) => {
      const handler = (payload: DeltaPayload) => {
        subscriber.next(payload);
      };
      this.socket.on('delta:ws', handler);
      return () => this.socket.off('delta:ws', handler);
    }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
  }

  ngOnDestroy(): void {
    this.socket.disconnect();
  }
}
