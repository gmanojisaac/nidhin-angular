import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatTableModule } from '@angular/material/table';
import { MatToolbarModule } from '@angular/material/toolbar';
import { combineLatest, defer, from, map, merge, scan, shareReplay, startWith, withLatestFrom } from 'rxjs';
import { BinancePayload, BinanceService } from '../binance/binance.service';
import { WebhookPayload, WebhookService } from '../webhook/webhook.service';
import { Tick, TickService } from './tick.service';

type InstrumentMeta = {
  tradingview?: string;
  zerodha: string;
  token: number;
};

type InstrumentLookup = {
  map: Map<number, string>;
  order: Map<number, number>;
  symbolLookup: Map<string, number>;
};

type FsmState = 'NOSIGNAL' | 'NOPOSITION_SIGNAL' | 'BUYPOSITION' | 'NOPOSITION_BLOCKED';

type InstrumentFsm = {
  state: FsmState;
  threshold: number | null;
  savedBUYThreshold: number | null;
  lastSignalAtMs: number | null;
  lastCheckedAtMs: number | null;
  lastBlockedAtMs: number | null;
};

type TickState = {
  ticks: Tick[];
  latestLtpByToken: Map<number, number>;
  latestBinanceBySymbol: Map<string, number>;
  fsmByToken: Map<number, InstrumentFsm>;
  fsmBySymbol: Map<string, InstrumentFsm>;
};

type TickRow = {
  symbol: string | null;
  ltp: number | null;
  threshold: number | null;
  noSignal: boolean;
  noPositionSignal: boolean;
  buyPosition: boolean;
  noPositionBlocked: boolean;
};

type TickEvent =
  | { type: 'tick'; tick: Tick; receivedAt: number }
  | { type: 'signal'; payload: WebhookPayload; token: number | null; receivedAt: number }
  | { type: 'binance'; payload: BinancePayload; token: number | null; receivedAt: number };

type TickTransitionResult = {
  next: InstrumentFsm;
  intermediate?: InstrumentFsm;
};

@Component({
  selector: 'app-tick',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCardModule, MatChipsModule, MatTableModule, MatToolbarModule],
  templateUrl: './tick.component.html',
  styleUrl: './tick.component.css'
})
export class TickComponent {
  private readonly tickService = inject(TickService);
  private readonly binanceService = inject(BinanceService);
  private readonly webhookService = inject(WebhookService);
  private readonly instrumentLookup$ = this.loadInstrumentMap();
  readonly displayedColumns = [
    'index',
    'symbol',
    'ltp',
    'threshold',
    'noSignal',
    'noPositionSignal',
    'buyPosition',
    'noPositionBlocked'
  ];

  private readonly tickState$ = this.buildTickState();

  readonly latestTicks$ = combineLatest([
    this.tickState$,
    this.instrumentLookup$,
    this.binanceService.binance$.pipe(startWith(null))
  ]).pipe(
    map(([state, instrumentLookup, binance]) => {
      const orderedTicks = [...state.ticks].sort((left, right) => {
        const leftToken = this.getInstrumentToken(left);
        const rightToken = this.getInstrumentToken(right);
        const leftIndex = leftToken === null
          ? Number.POSITIVE_INFINITY
          : instrumentLookup.order.get(leftToken) ?? Number.POSITIVE_INFINITY;
        const rightIndex = rightToken === null
          ? Number.POSITIVE_INFINITY
          : instrumentLookup.order.get(rightToken) ?? Number.POSITIVE_INFINITY;
        return leftIndex - rightIndex;
      });
      const rows = orderedTicks.map((tick) => {
        const token = this.getInstrumentToken(tick);
        const fsm = token === null ? null : state.fsmByToken.get(token) ?? this.defaultFsm();
        return this.toRow(tick, instrumentLookup.map, fsm);
      });
      const binanceFsm = binance?.symbol
        ? state.fsmBySymbol.get(binance.symbol) ?? this.defaultFsm()
        : this.defaultFsm();
      const binanceRow = this.toBinanceRow(binance, binanceFsm);
      return binanceRow ? [...rows, binanceRow] : rows;
    })
  );

  formatNumber(value: number | null): string {
    if (value === null || Number.isNaN(value)) {
      return '--';
    }
    return value.toFixed(2);
  }

  clearCache(): void {
    this.tickService.clearCache();
  }

  private buildTickState() {
    const initialState: TickState = {
      ticks: [],
      latestLtpByToken: new Map<number, number>(),
      latestBinanceBySymbol: new Map<string, number>(),
      fsmByToken: new Map<number, InstrumentFsm>(),
      fsmBySymbol: new Map<string, InstrumentFsm>()
    };

    const tickEvents$ = this.tickService.ticks$.pipe(
      map((tick) => ({ type: 'tick', tick, receivedAt: Date.now() }) as TickEvent)
    );

    const signalEvents$ = this.webhookService.webhook$.pipe(
      withLatestFrom(this.instrumentLookup$),
      map(([payload, lookup]) => {
        const isBinanceSymbol = this.isBinanceSymbol(payload.symbol);
        const token = isBinanceSymbol ? null : this.getTokenForSymbol(payload.symbol, lookup.symbolLookup);
        console.log('[tick] webhook mapped', { symbol: payload.symbol, token, bySymbol: isBinanceSymbol });
        return {
          type: 'signal',
          payload,
          token,
          receivedAt: Date.now()
        } as TickEvent;
      })
    );

    const binanceEvents$ = this.binanceService.binance$.pipe(
      withLatestFrom(this.instrumentLookup$),
      map(([payload, lookup]) => {
        const isBinanceSymbol = this.isBinanceSymbol(payload.symbol);
        return {
          type: 'binance',
          payload,
          token: isBinanceSymbol ? null : this.getTokenForSymbol(payload.symbol, lookup.symbolLookup),
          receivedAt: Date.now()
        } as TickEvent;
      })
    );

    return merge(tickEvents$, signalEvents$, binanceEvents$).pipe(
      scan((state, event) => this.reduceTickState(state, event), initialState),
      startWith(initialState),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  private reduceTickState(state: TickState, event: TickEvent): TickState {
    if (event.type === 'tick') {
      const token = this.getInstrumentToken(event.tick);
      const nextTicks = this.updateTicks(state.ticks, event.tick, token);
      const latestLtpByToken = new Map(state.latestLtpByToken);
      const tickLtp = this.getTickLtp(event.tick);
      if (token !== null && tickLtp !== null) {
        latestLtpByToken.set(token, tickLtp);
      }
      const fsmByToken = new Map(state.fsmByToken);
      if (token !== null) {
        const existing = fsmByToken.get(token) ?? this.defaultFsm();
        const result = this.applyTickTransition(existing, tickLtp, event.receivedAt);
        if (result.intermediate) {
          this.logFsmTransition('tick', null, existing, result.intermediate, tickLtp, event.receivedAt);
          this.logFsmTransition('tick', null, result.intermediate, result.next, tickLtp, event.receivedAt);
        } else {
          this.logFsmTransition('tick', null, existing, result.next, tickLtp, event.receivedAt);
        }
        fsmByToken.set(token, result.next);
      }
      return {
        ticks: nextTicks,
        latestLtpByToken,
        latestBinanceBySymbol: state.latestBinanceBySymbol,
        fsmByToken,
        fsmBySymbol: state.fsmBySymbol
      };
    }

    if (event.type === 'signal') {
      const signal = this.getSignalType(event.payload);
      if (this.isBinanceSymbol(event.payload.symbol)) {
        const fsmBySymbol = new Map(state.fsmBySymbol);
        const existing = fsmBySymbol.get(event.payload.symbol) ?? this.defaultFsm();
        const binanceFallback = this.getBinanceFallbackLtp(event.payload.symbol, state.latestBinanceBySymbol);
        const next = this.applySignalTransition(
          existing,
          signal,
          event.payload,
          binanceFallback,
          event.receivedAt
        );
        this.logFsmTransition('signal', event.payload.symbol, existing, next, binanceFallback, event.receivedAt);
        fsmBySymbol.set(event.payload.symbol, next);
        return { ...state, fsmBySymbol };
      }
      const fsmByToken = new Map(state.fsmByToken);
      const token = event.token;
      if (token === null) {
        return state;
      }
      const existing = fsmByToken.get(token) ?? this.defaultFsm();
      const next = this.applySignalTransition(
        existing,
        signal,
        event.payload,
        state.latestLtpByToken.get(token) ?? null,
        event.receivedAt
      );
      this.logFsmTransition('signal', event.payload.symbol, existing, next, state.latestLtpByToken.get(token) ?? null, event.receivedAt);
      fsmByToken.set(token, next);
      return { ...state, fsmByToken };
    }

    if (event.type === 'binance') {
      const token = event.token;
      const symbol = event.payload.symbol ?? '';
      if (token === null && !symbol) {
        return state;
      }
      const price = typeof event.payload.price === 'number' ? event.payload.price : null;
      if (price === null) {
        return state;
      }
      const latestLtpByToken = new Map(state.latestLtpByToken);
      if (token !== null) {
        latestLtpByToken.set(token, price);
      }
      const latestBinanceBySymbol = new Map(state.latestBinanceBySymbol);
      if (symbol) {
        latestBinanceBySymbol.set(symbol, price);
      }
      const fsmByToken = new Map(state.fsmByToken);
      if (token !== null) {
        const existing = fsmByToken.get(token) ?? this.defaultFsm();
        const result = this.applyTickTransition(existing, price, event.receivedAt);
        if (result.intermediate) {
          this.logFsmTransition('tick', symbol || null, existing, result.intermediate, price, event.receivedAt);
          this.logFsmTransition('tick', symbol || null, result.intermediate, result.next, price, event.receivedAt);
        } else {
          this.logFsmTransition('tick', symbol || null, existing, result.next, price, event.receivedAt);
        }
        fsmByToken.set(token, result.next);
      }
      const fsmBySymbol = new Map(state.fsmBySymbol);
      if (this.isBinanceSymbol(symbol)) {
        const existing = fsmBySymbol.get(symbol) ?? this.defaultFsm();
        const result = this.applyTickTransition(existing, price, event.receivedAt);
        if (result.intermediate) {
          this.logFsmTransition('binance', symbol, existing, result.intermediate, price, event.receivedAt);
          this.logFsmTransition('binance', symbol, result.intermediate, result.next, price, event.receivedAt);
        } else {
          this.logFsmTransition('binance', symbol, existing, result.next, price, event.receivedAt);
        }
        fsmBySymbol.set(symbol, result.next);
      }
      return { ...state, latestLtpByToken, latestBinanceBySymbol, fsmByToken, fsmBySymbol };
    }

    return state;
  }

  private updateTicks(ticks: Tick[], tick: Tick, token: number | null): Tick[] {
    const filtered = token === null
      ? ticks
      : ticks.filter((existing) => this.getInstrumentToken(existing) !== token);
    return [tick, ...filtered].slice(0, 6);
  }

  private applySignalTransition(
    current: InstrumentFsm,
    signal: 'BUY' | 'SELL' | null,
    payload: WebhookPayload,
    latestLtp: number | null,
    receivedAt: number
  ): InstrumentFsm {
    if (!signal) {
      return current;
    }
    if (signal === 'BUY') {
      const threshold = typeof payload.stoppx === 'number' ? payload.stoppx : null;
      return {
        state: 'NOPOSITION_SIGNAL',
        threshold,
        savedBUYThreshold: threshold,
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
      lastSignalAtMs: receivedAt,
      lastCheckedAtMs: null,
      lastBlockedAtMs: null
    };
  }

  private applyTickTransition(current: InstrumentFsm, ltp: number | null, receivedAt: number): TickTransitionResult {
    if (current.threshold === null || current.lastSignalAtMs === null || ltp === null) {
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
        return { next: current };
      }
      const nextState = ltp > current.threshold ? 'BUYPOSITION' : 'NOPOSITION_BLOCKED';
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
      const nextState = ltp > current.threshold ? 'BUYPOSITION' : 'NOPOSITION_BLOCKED';
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

  private getSignalType(payload: WebhookPayload): 'BUY' | 'SELL' | null {
    const intentCandidate = `${payload.intent ?? ''}`.toUpperCase();
    if (intentCandidate === 'BUY') {
      return 'BUY';
    }
    if (intentCandidate === 'SELL') {
      return 'SELL';
    }
    if (intentCandidate === 'ENTRY') {
      return 'BUY';
    }
    if (intentCandidate === 'EXIT') {
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

  private getBinanceFallbackLtp(symbol: string | undefined, latestBySymbol: Map<string, number>): number | null {
    if (!symbol) {
      return null;
    }
    return latestBySymbol.get(symbol) ?? null;
  }

  private isBinanceSymbol(symbol: string | undefined): symbol is string {
    return typeof symbol === 'string' && symbol.toUpperCase() === 'BTCUSDT';
  }

  private logFsmTransition(
    source: 'signal' | 'tick' | 'binance',
    symbol: string | null | undefined,
    prev: InstrumentFsm,
    next: InstrumentFsm,
    ltp: number | null,
    receivedAt: number
  ): void {
    if (prev.state === next.state && prev.threshold === next.threshold) {
      return;
    }
    console.log('[tick] fsm transition', {
      source,
      symbol: symbol ?? '--',
      prevState: prev.state,
      nextState: next.state,
      threshold: next.threshold,
      ltp,
      at: new Date(receivedAt).toISOString()
    });
  }

  private defaultFsm(): InstrumentFsm {
    return {
      state: 'NOSIGNAL',
      threshold: null,
      savedBUYThreshold: null,
      lastSignalAtMs: null,
      lastCheckedAtMs: null,
      lastBlockedAtMs: null
    };
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

  private toRow(tick: Tick, instrumentMap: Map<number, string>, fsm: InstrumentFsm | null): TickRow {
    if (typeof tick === 'object' && tick !== null) {
      const candidate = tick as {
        instrument_token?: unknown;
        last_price?: unknown;
      };
      const instrumentToken = typeof candidate.instrument_token === 'number'
        ? candidate.instrument_token
        : null;
      const ltp = typeof candidate.last_price === 'number' ? candidate.last_price : null;
      return this.toStateRow(
        instrumentToken === null ? null : instrumentMap.get(instrumentToken) ?? null,
        ltp,
        fsm ?? this.defaultFsm()
      );
    }
    return this.toStateRow(null, null, fsm ?? this.defaultFsm());
  }

  private toBinanceRow(payload: BinancePayload | null, fsm: InstrumentFsm): TickRow | null {
    if (!payload) {
      return null;
    }
    return this.toStateRow(
      payload.symbol ?? null,
      typeof payload.price === 'number' ? payload.price : null,
      fsm
    );
  }

  private toStateRow(symbol: string | null, ltp: number | null, fsm: InstrumentFsm): TickRow {
    return {
      symbol,
      ltp,
      threshold: fsm.threshold,
      noSignal: fsm.state === 'NOSIGNAL',
      noPositionSignal: fsm.state === 'NOPOSITION_SIGNAL',
      buyPosition: fsm.state === 'BUYPOSITION',
      noPositionBlocked: fsm.state === 'NOPOSITION_BLOCKED'
    };
  }

  private loadInstrumentMap() {
    return defer(() => from(this.fetchInstrumentMap())).pipe(
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  private async fetchInstrumentMap(): Promise<InstrumentLookup> {
    try {
      const response = await fetch('/instruments.json', { cache: 'no-store' });
      if (!response.ok) {
        return { map: new Map<number, string>(), order: new Map<number, number>(), symbolLookup: new Map<string, number>() };
      }
      const parsed = await response.json();
      const meta = Array.isArray(parsed) ? (parsed as InstrumentMeta[]) : [];
      return this.buildMapFromMeta(meta);
    } catch {
      return { map: new Map<number, string>(), order: new Map<number, number>(), symbolLookup: new Map<string, number>() };
    }
  }

  private buildMapFromMeta(meta: InstrumentMeta[]): InstrumentLookup {
    const map = new Map<number, string>();
    const order = new Map<number, number>();
    const symbolLookup = new Map<string, number>();
    meta.forEach((instrument, index) => {
      if (typeof instrument.token === 'number' && typeof instrument.zerodha === 'string') {
        map.set(instrument.token, instrument.zerodha);
        order.set(instrument.token, index);
        symbolLookup.set(instrument.zerodha, instrument.token);
      }
      if (typeof instrument.token === 'number' && typeof instrument.tradingview === 'string') {
        symbolLookup.set(instrument.tradingview, instrument.token);
      }
    });
    return { map, order, symbolLookup };
  }
}
