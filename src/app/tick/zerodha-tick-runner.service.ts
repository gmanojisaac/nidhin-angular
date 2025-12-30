import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subscription, defer, from, map, merge, scan, shareReplay, startWith, switchMap } from 'rxjs';
import { TickFsmStateService, FsmSymbolSnapshot } from './tick-fsm-state.service';
import { WebhookPayload, WebhookService } from '../webhook/webhook.service';
import { Tick, TickService } from './tick.service';

type InstrumentMeta = {
  tradingview?: string;
  zerodha: string;
  token: number;
};

type InstrumentLookup = {
  map: Map<number, string>;
  symbolLookup: Map<string, number>;
};

type FsmState = 'NOSIGNAL' | 'NOPOSITION_SIGNAL' | 'BUYPOSITION' | 'SELLPOSITION' | 'NOPOSITION_BLOCKED';

type InstrumentFsm = {
  state: FsmState;
  threshold: number | null;
  savedBUYThreshold: number | null;
  lastBUYThreshold: number | null;
  lastSELLThreshold: number | null;
  lastSignalAtMs: number | null;
  lastCheckedAtMs: number | null;
  lastBlockedAtMs: number | null;
};

type TickState = {
  fsmByToken: Map<number, InstrumentFsm>;
  latestLtpByToken: Map<number, number>;
};

type TickEvent =
  | { type: 'tick'; tick: Tick; receivedAt: number }
  | { type: 'signal'; payload: WebhookPayload; token: number | null; receivedAt: number };

@Injectable({ providedIn: 'root' })
export class ZerodhaTickRunnerService implements OnDestroy {
  private readonly tickService = inject(TickService);
  private readonly webhookService = inject(WebhookService);
  private readonly fsmStateService = inject(TickFsmStateService);
  private readonly subs = new Subscription();
  private readonly lastStuckLogAtBySymbol = new Map<string, number>();
  private readonly instrumentLookup$ = defer(() => from(this.fetchInstrumentMap())).pipe(
    shareReplay({ bufferSize: 1, refCount: false })
  );

  constructor() {
    this.subs.add(
      this.instrumentLookup$.pipe(
        switchMap((lookup) => {
          const initialState = this.buildInitialState();
          const tickEvents$ = this.tickService.ticks$.pipe(
            map((tick) => ({ type: 'tick', tick, receivedAt: Date.now() }) as TickEvent)
          );
          const signalEvents$ = this.webhookService.webhook$.pipe(
            map((payload) => ({
              type: 'signal',
              payload,
              token: this.getTokenForSymbol(payload.symbol, lookup.symbolLookup),
              receivedAt: Date.now()
            }) as TickEvent)
          );
          return merge(tickEvents$, signalEvents$).pipe(
            scan((state, event) => this.reduceTickState(state, event, lookup), initialState),
            startWith(initialState),
            map((state) => ({ state, lookup }))
          );
        })
      ).subscribe(({ state, lookup }) => {
        const snapshot = this.buildFsmSnapshot(state, lookup);
        if (snapshot.size > 0) {
          this.fsmStateService.update(snapshot);
        }
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  private buildInitialState(): TickState {
    return {
      fsmByToken: new Map<number, InstrumentFsm>(),
      latestLtpByToken: new Map<number, number>()
    };
  }

  private reduceTickState(state: TickState, event: TickEvent, lookup: InstrumentLookup): TickState {
    if (event.type === 'tick') {
      const token = this.getInstrumentToken(event.tick);
      const tickLtp = this.getTickLtp(event.tick);
      const latestLtpByToken = new Map(state.latestLtpByToken);
      if (token !== null && tickLtp !== null) {
        latestLtpByToken.set(token, tickLtp);
      }
      const fsmByToken = new Map(state.fsmByToken);
      if (token !== null) {
        const existing = fsmByToken.get(token) ?? this.defaultFsm();
        const symbol = lookup.map.get(token) ?? null;
        const result = this.applyTickTransition(existing, tickLtp, event.receivedAt, symbol);
        fsmByToken.set(token, result.next);
      }
      return { fsmByToken, latestLtpByToken };
    }

    if (event.type === 'signal') {
      const signal = this.getSignalType(event.payload);
      if (!signal) {
        return state;
      }
      const token = event.token;
      if (token === null) {
        this.logStuck(event.payload.symbol ?? '--', 'missing token');
        return state;
      }
      const fsmByToken = new Map(state.fsmByToken);
      const existing = fsmByToken.get(token) ?? this.defaultFsm();
      const next = this.applySignalTransition(
        existing,
        signal,
        event.payload,
        state.latestLtpByToken.get(token) ?? null,
        event.receivedAt
      );
      fsmByToken.set(token, next);
      return { ...state, fsmByToken };
    }

    return state;
  }

  private applySignalTransition(
    current: InstrumentFsm,
    signal: 'BUY' | 'SELL',
    payload: WebhookPayload,
    latestLtp: number | null,
    receivedAt: number
  ): InstrumentFsm {
    if (this.isPositionState(current.state)) {
      if (signal === 'BUY') {
        const threshold = typeof payload.stoppx === 'number' ? payload.stoppx : current.threshold;
        return {
          ...current,
          threshold,
          savedBUYThreshold: threshold,
          lastBUYThreshold: threshold,
          lastSignalAtMs: receivedAt
        };
      }
      const threshold = latestLtp ?? current.threshold;
      return {
        ...current,
        threshold,
        lastSELLThreshold: threshold,
        lastSignalAtMs: receivedAt
      };
    }
    if (signal === 'BUY') {
      const threshold = typeof payload.stoppx === 'number' ? payload.stoppx : null;
      return {
        state: 'NOPOSITION_SIGNAL',
        threshold,
        savedBUYThreshold: threshold,
        lastBUYThreshold: threshold,
        lastSELLThreshold: current.lastSELLThreshold,
        lastSignalAtMs: receivedAt,
        lastCheckedAtMs: null,
        lastBlockedAtMs: null
      };
    }
    const threshold = latestLtp;
    return {
      state: 'NOPOSITION_SIGNAL',
      threshold,
      savedBUYThreshold: current.savedBUYThreshold,
      lastBUYThreshold: current.lastBUYThreshold,
      lastSELLThreshold: threshold,
      lastSignalAtMs: receivedAt,
      lastCheckedAtMs: null,
      lastBlockedAtMs: null
    };
  }

  private applyTickTransition(
    current: InstrumentFsm,
    ltp: number | null,
    receivedAt: number,
    symbol: string | null
  ): { next: InstrumentFsm; intermediate?: InstrumentFsm } {
    if (current.threshold === null || current.lastSignalAtMs === null || ltp === null) {
      if (current.lastSignalAtMs !== null) {
        this.logStuck(symbol ?? '--', 'missing threshold/ltp');
      }
      return { next: current };
    }
    if (current.state === 'BUYPOSITION') {
      if (ltp >= current.threshold) {
        return { next: current };
      }
      return {
        next: {
          ...current,
          state: 'NOPOSITION_BLOCKED',
          lastCheckedAtMs: receivedAt,
          lastBlockedAtMs: receivedAt
        }
      };
    }
    if (current.state === 'NOPOSITION_SIGNAL') {
      if (current.lastCheckedAtMs !== null && current.lastCheckedAtMs >= current.lastSignalAtMs) {
        this.logStuck(symbol ?? '--', 'already checked');
        return { next: current };
      }
      const nextState: FsmState = ltp > current.threshold ? 'BUYPOSITION' : 'NOPOSITION_BLOCKED';
      return {
        next: {
          ...current,
          state: nextState,
          lastCheckedAtMs: receivedAt,
          lastBlockedAtMs: nextState === 'NOPOSITION_BLOCKED' ? receivedAt : null
        }
      };
    }
    if (current.state === 'NOPOSITION_BLOCKED') {
      if (!this.isFirstSecondNextMinute(current.lastBlockedAtMs, receivedAt)) {
        return { next: current };
      }
      const intermediate: InstrumentFsm = {
        ...current,
        state: 'NOPOSITION_SIGNAL',
        lastSignalAtMs: receivedAt,
        lastCheckedAtMs: null,
        lastBlockedAtMs: null
      };
      const nextState: FsmState = ltp > current.threshold ? 'BUYPOSITION' : 'NOPOSITION_BLOCKED';
      const finalState: InstrumentFsm = {
        ...intermediate,
        state: nextState,
        lastCheckedAtMs: receivedAt,
        lastBlockedAtMs: nextState === 'NOPOSITION_BLOCKED' ? receivedAt : null
      };
      return { intermediate, next: finalState };
    }
    return { next: current };
  }

  private logStuck(symbol: string, reason: string): void {
    const now = Date.now();
    const lastLogAt = this.lastStuckLogAtBySymbol.get(symbol) ?? 0;
    if (now - lastLogAt < 10000) {
      return;
    }
    this.lastStuckLogAtBySymbol.set(symbol, now);
    console.log(`[zerodha6] stuck symbol=${symbol} reason=${reason}`);
  }

  private buildFsmSnapshot(state: TickState, lookup: InstrumentLookup): Map<string, FsmSymbolSnapshot> {
    const snapshot = new Map<string, FsmSymbolSnapshot>();
    for (const [token, fsm] of state.fsmByToken.entries()) {
      const symbol = lookup.map.get(token);
      if (!symbol) {
        continue;
      }
      snapshot.set(symbol, {
        state: fsm.state,
        ltp: state.latestLtpByToken.get(token) ?? null,
        threshold: fsm.threshold,
        lastBUYThreshold: fsm.lastBUYThreshold,
        lastSELLThreshold: fsm.lastSELLThreshold,
        lastBlockedAtMs: fsm.lastBlockedAtMs
      });
    }
    return snapshot;
  }

  private getInstrumentToken(tick: Tick): number | null {
    if (typeof tick === 'object' && tick !== null && 'instrument_token' in tick) {
      const value = (tick as { instrument_token?: unknown }).instrument_token;
      return typeof value === 'number' ? value : null;
    }
    return null;
  }

  private getTickLtp(tick: Tick): number | null {
    if (typeof tick === 'object' && tick !== null && 'last_price' in tick) {
      const value = (tick as { last_price?: unknown }).last_price;
      return typeof value === 'number' ? value : null;
    }
    return null;
  }

  private getSignalType(payload: WebhookPayload): 'BUY' | 'SELL' | null {
    const intentCandidate = `${payload.intent ?? ''}`.toUpperCase();
    if (intentCandidate === 'BUY' || intentCandidate === 'ENTRY') {
      return 'BUY';
    }
    if (intentCandidate === 'SELL' || intentCandidate === 'EXIT') {
      return 'SELL';
    }
    const sideCandidate = `${payload.side ?? ''}`.toUpperCase();
    if (sideCandidate === 'BUY') {
      return 'BUY';
    }
    if (sideCandidate === 'SELL') {
      return 'SELL';
    }
    return null;
  }

  private getTokenForSymbol(symbol: string | undefined, lookup: Map<string, number>): number | null {
    if (!symbol) {
      return null;
    }
    return lookup.get(symbol) ?? null;
  }

  private isPositionState(state: InstrumentFsm['state']): boolean {
    return state === 'BUYPOSITION' || state === 'SELLPOSITION';
  }

  private isFirstSecondNextMinute(anchorAtMs: number | null, tickAtMs: number): boolean {
    if (anchorAtMs === null) {
      return false;
    }
    const signalMinute = Math.floor(anchorAtMs / 60000);
    const tickMinute = Math.floor(tickAtMs / 60000);
    if (tickMinute <= signalMinute) {
      return false;
    }
    return new Date(tickAtMs).getSeconds() === 0;
  }

  private defaultFsm(): InstrumentFsm {
    return {
      state: 'NOSIGNAL',
      threshold: null,
      savedBUYThreshold: null,
      lastBUYThreshold: null,
      lastSELLThreshold: null,
      lastSignalAtMs: null,
      lastCheckedAtMs: null,
      lastBlockedAtMs: null
    };
  }

  private async fetchInstrumentMap(): Promise<InstrumentLookup> {
    try {
      const response = await fetch('/instruments.json', { cache: 'no-store' });
      if (!response.ok) {
        return { map: new Map<number, string>(), symbolLookup: new Map<string, number>() };
      }
      const parsed = await response.json();
      const meta = Array.isArray(parsed) ? (parsed as InstrumentMeta[]) : [];
      const map = new Map<number, string>();
      const symbolLookup = new Map<string, number>();
      meta.forEach((instrument) => {
        if (typeof instrument.token === 'number' && typeof instrument.zerodha === 'string') {
          map.set(instrument.token, instrument.zerodha);
          symbolLookup.set(instrument.zerodha, instrument.token);
        }
        if (typeof instrument.token === 'number' && typeof instrument.tradingview === 'string') {
          symbolLookup.set(instrument.tradingview, instrument.token);
        }
      });
      return { map, symbolLookup };
    } catch {
      return { map: new Map<number, string>(), symbolLookup: new Map<string, number>() };
    }
  }
}
