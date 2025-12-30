import { Injectable, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable, shareReplay } from 'rxjs';

export type DeltaRestPayload = {
  exchange?: string;
  symbol?: string;
  price?: number;
  timestamp?: number;
  raw?: unknown;
};

@Injectable({ providedIn: 'root' })
export class DeltaRestService implements OnDestroy {
  private readonly socket: Socket;
  readonly deltaRest$: Observable<DeltaRestPayload>;

  constructor() {
    this.socket = io('http://localhost:3002');

    this.deltaRest$ = new Observable<DeltaRestPayload>((subscriber) => {
      const handler = (payload: DeltaRestPayload) => subscriber.next(payload);
      this.socket.on('delta:rest', handler);
      return () => this.socket.off('delta:rest', handler);
    }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
  }

  ngOnDestroy(): void {
    this.socket.disconnect();
  }
}
