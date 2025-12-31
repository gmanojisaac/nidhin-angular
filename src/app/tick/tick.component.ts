import { CommonModule } from '@angular/common';
import { Component, Input, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatTableModule } from '@angular/material/table';
import { MatToolbarModule } from '@angular/material/toolbar';
import { BehaviorSubject, combineLatest, defer, from, map, merge, scan, shareReplay, startWith, switchMap } from 'rxjs';
import { BinancePayload, BinanceService } from '../binance/binance.service';
import { FsmSymbolSnapshot, TickFsmStateService } from './tick-fsm-state.service';
import { RelayService } from '../relay/relay.service';
import { WebhookPayload, WebhookService } from '../webhook/webhook.service';
import { Tick, TickService } from './tick.service';

type InstrumentMeta = {
  tradingview?: string;
  zerodha: string;
  token: number;
  lot?: number;
};

type InstrumentLookup = {
  map: Map<number, string>;
  order: Map<number, number>;
  symbolLookup: Map<string, number>;
  tokenSymbols: Map<number, string[]>;
  lotBySymbol: Map<string, number>;
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
  quantity: number | null;
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
  private readonly fsmStateService = inject(TickFsmStateService);
  private readonly relayService = inject(RelayService);
  private loggedMissingBtcThreshold = false;
  private lastZerodhaLogAt = 0;
  private readonly lastStuckLogAtBySymbol = new Map<string, number>();
  private readonly instrumentLookup$ = this.loadInstrumentMap();
  @Input() includeBinance = false;
  @Input() binanceSymbols: string[] | null = null;
  @Input() title = 'Latest 6 Instruments';
  @Input() enableLogs = true;
  @Input() set enableProcessing(value: boolean) {
    this.enableProcessing$.next(value !== false);
  }
  readonly displayedColumns = [
    'index',
    'symbol',
    'ltp',
    'quantity',
    'threshold',
    'noSignal',
    'noPositionSignal',
    'buyPosition',
    'noPositionBlocked'
  ];

  private readonly enableProcessing$ = new BehaviorSubject<boolean>(true);

  readonly latestTicks$ = this.enableProcessing$.pipe(
    switchMap((enabled) => enabled ? this.buildProcessedTicks$() : this.buildViewOnlyTicks$())
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
    return this.instrumentLookup$.pipe(
      switchMap((lookup) => {
        const initialState = this.buildInitialState(lookup);
        const tickEvents$ = this.tickService.ticks$.pipe(
          map((tick) => ({ type: 'tick', tick, receivedAt: Date.now() }) as TickEvent)
        );

        const signalEvents$ = this.webhookService.webhook$.pipe(
          map((payload) => {
            const isBinanceSymbol = this.isBinanceSymbol(payload.symbol);
            const token = isBinanceSymbol ? null : this.getTokenForSymbol(payload.symbol, lookup.symbolLookup);
            this.log(
              `[tick] webhook mapped symbol=${payload.symbol ?? '--'} token=${token ?? '--'} bySymbol=${isBinanceSymbol}`
            );
            return {
              type: 'signal',
              payload,
              token,
              receivedAt: Date.now()
            } as TickEvent;
          })
        );

        const binanceEvents$ = this.binanceService.binance$.pipe(
          map((payload) => {
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
      })
    );
  }

  private buildProcessedTicks$() {
    return combineLatest([
      this.buildTickState(),
      this.instrumentLookup$
    ]).pipe(
      map(([state, instrumentLookup]) => {
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
        const tickRows = orderedTicks.map((tick) => {
          const token = this.getInstrumentToken(tick);
          const fsm = token === null ? null : state.fsmByToken.get(token) ?? this.defaultFsm();
          return this.toRow(tick, instrumentLookup.map, fsm, instrumentLookup.lotBySymbol);
        });
        const snapshot = this.buildFsmSnapshot(state, instrumentLookup);
        const rows = this.includeBinance
          ? this.buildBinanceRows(state, snapshot, instrumentLookup.lotBySymbol)
          : tickRows.slice(0, 6);
        return { rows, snapshot };
      }),
      map(({ rows, snapshot }) => {
        const current = this.fsmStateService.getSnapshot();
        let nextSnapshot = snapshot.size === 0 && current.size > 0 ? current : snapshot;
        if (this.includeBinance) {
          const symbols = this.getBinanceSymbols();
          for (const symbol of symbols) {
            if (current.has(symbol) && !nextSnapshot.has(symbol)) {
              nextSnapshot = new Map(nextSnapshot);
              const existing = current.get(symbol);
              if (existing) {
                nextSnapshot.set(symbol, existing);
              }
            }
          }
        }
        this.fsmStateService.update(nextSnapshot);
        this.logZerodhaRows(rows);
        return rows;
      })
    );
  }

  private buildViewOnlyTicks$() {
    const tickList$ = this.tickService.ticks$.pipe(
      scan((ticks, tick) => this.updateTicks(ticks, tick, this.getInstrumentToken(tick)), [] as Tick[]),
      startWith([] as Tick[])
    );
    return combineLatest([tickList$, this.instrumentLookup$, this.fsmStateService.fsmBySymbol$]).pipe(
      map(([ticks, instrumentLookup, snapshot]) => {
        const orderedTicks = [...ticks].sort((left, right) => {
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
          const symbol = token === null ? null : instrumentLookup.map.get(token) ?? null;
          const snap = symbol ? snapshot.get(symbol) : null;
          const fsm = snap
            ? {
              ...this.defaultFsm(),
              state: snap.state,
              threshold: snap.threshold,
              lastBUYThreshold: snap.lastBUYThreshold,
              lastSELLThreshold: snap.lastSELLThreshold,
              lastBlockedAtMs: snap.lastBlockedAtMs
            }
            : this.defaultFsm();
          return this.toStateRow(symbol, this.getTickLtp(tick), fsm, instrumentLookup.lotBySymbol);
        });
        if (this.includeBinance) {
          const binanceState: TickState = {
            ticks: [],
            latestLtpByToken: new Map<number, number>(),
            latestBinanceBySymbol: new Map<string, number>(),
            fsmByToken: new Map<number, InstrumentFsm>(),
            fsmBySymbol: new Map<string, InstrumentFsm>()
          };
          return this.buildBinanceRows(binanceState, snapshot, instrumentLookup.lotBySymbol);
        }
        const limited = rows.slice(0, 6);
        this.logZerodhaRows(limited);
        return limited;
      })
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
        return state;
      }
      const fsmByToken = new Map(state.fsmByToken);
      const token = event.token;
      if (token === null) {
        this.logStuck('signal', event.payload.symbol ?? '--', this.defaultFsm(), null, event.receivedAt, 'missing token');
        return state;
      }
      const existing = fsmByToken.get(token) ?? this.defaultFsm();
      if (existing.state === 'NOPOSITION_SIGNAL' && (state.latestLtpByToken.get(token) ?? null) === null) {
        this.logStuck('signal', event.payload.symbol ?? '--', existing, null, event.receivedAt, 'missing ltp');
      }
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
        if (this.isBinanceSymbol(symbol)) {
          this.fsmStateService.updateLastPrice(symbol, price);
        }
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
      return { ...state, latestLtpByToken, latestBinanceBySymbol, fsmByToken, fsmBySymbol: state.fsmBySymbol };
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
    if (this.isPositionState(current.state)) {
      if (signal === 'BUY') {
        const threshold = typeof payload.stoppx === 'number' ? payload.stoppx : current.threshold;
        if (threshold !== current.threshold) {
          this.log(
            `[tick] in-position threshold update symbol=${payload.symbol ?? '--'} signal=BUY from=${current.threshold ?? '--'} to=${threshold ?? '--'}`
          );
        }
        return {
          ...current,
          threshold,
          savedBUYThreshold: threshold,
          lastBUYThreshold: threshold,
          lastSignalAtMs: receivedAt
        };
      }
      const threshold = latestLtp ?? current.threshold;
      if (threshold !== current.threshold) {
        this.log(
          `[tick] in-position threshold update symbol=${payload.symbol ?? '--'} signal=SELL from=${current.threshold ?? '--'} to=${threshold ?? '--'}`
        );
      }
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

  private isPositionState(state: InstrumentFsm['state']): boolean {
    return state === 'BUYPOSITION' || state === 'SELLPOSITION';
  }

  private applyTickTransition(current: InstrumentFsm, ltp: number | null, receivedAt: number): TickTransitionResult {
    if (current.threshold === null || current.lastSignalAtMs === null || ltp === null) {
      if (current.lastSignalAtMs !== null) {
        this.logStuck('tick', '--', current, ltp, receivedAt, 'missing threshold/ltp');
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
        this.logStuck('tick', '--', current, ltp, receivedAt, 'already checked');
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

  getPositionLabel(): string {
    const symbols = this.getBinanceSymbols();
    const isShort = this.includeBinance
      && symbols.length > 0
      && symbols.every((symbol) => symbol.endsWith('_SHORT'));
    return isShort ? 'SELLPOSITION' : 'BUYPOSITION';
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
    this.log(
      `[tick] fsm transition source=${source} symbol=${symbol ?? '--'} prev=${prev.state} next=${next.state} threshold=${next.threshold ?? '--'} ltp=${ltp ?? '--'} at=${new Date(receivedAt).toISOString()}`
    );
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

  private buildInitialState(lookup: InstrumentLookup): TickState {
    const snapshot = this.fsmStateService.getSnapshot();
    const now = Date.now();
    const fsmByToken = new Map<number, InstrumentFsm>();
    for (const [token, symbols] of lookup.tokenSymbols.entries()) {
      let snap: FsmSymbolSnapshot | undefined;
      for (const symbol of symbols) {
        const candidate = snapshot.get(symbol);
        if (candidate) {
          snap = candidate;
          break;
        }
      }
      if (!snap) {
        continue;
      }
      fsmByToken.set(token, {
        state: snap.state,
        threshold: snap.threshold,
        savedBUYThreshold: snap.lastBUYThreshold,
        lastBUYThreshold: snap.lastBUYThreshold,
        lastSELLThreshold: snap.lastSELLThreshold,
        lastSignalAtMs: snap.state === 'NOSIGNAL' ? null : now,
        lastCheckedAtMs: null,
        lastBlockedAtMs: snap.state === 'NOPOSITION_BLOCKED' ? now : null
      });
    }
    return {
      ticks: [],
      latestLtpByToken: new Map<number, number>(),
      latestBinanceBySymbol: new Map<string, number>(),
      fsmByToken,
      fsmBySymbol: new Map<string, InstrumentFsm>()
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

  private toRow(
    tick: Tick,
    instrumentMap: Map<number, string>,
    fsm: InstrumentFsm | null,
    lotBySymbol: Map<string, number>
  ): TickRow {
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
        fsm ?? this.defaultFsm(),
        lotBySymbol
      );
    }
    return this.toStateRow(null, null, fsm ?? this.defaultFsm(), lotBySymbol);
  }

  private toBinanceRow(
    payload: BinancePayload | null,
    fsm: InstrumentFsm,
    lotBySymbol: Map<string, number>
  ): TickRow | null {
    if (!payload) {
      return null;
    }
    return this.toStateRow(
      payload.symbol ?? null,
      typeof payload.price === 'number' ? payload.price : null,
      fsm,
      lotBySymbol
    );
  }

  private toStateRow(
    symbol: string | null,
    ltp: number | null,
    fsm: InstrumentFsm,
    lotBySymbol: Map<string, number>
  ): TickRow {
    return {
      symbol,
      ltp,
      threshold: fsm.threshold,
      quantity: this.computeQuantity(symbol, ltp, lotBySymbol),
      noSignal: fsm.state === 'NOSIGNAL',
      noPositionSignal: fsm.state === 'NOPOSITION_SIGNAL',
      buyPosition: fsm.state === 'BUYPOSITION' || fsm.state === 'SELLPOSITION',
      noPositionBlocked: fsm.state === 'NOPOSITION_BLOCKED'
    };
  }

  private buildBinanceRows(
    state: TickState,
    snapshot: Map<string, FsmSymbolSnapshot>,
    lotBySymbol: Map<string, number>
  ): TickRow[] {
    const rows: TickRow[] = [];
    const persistedSnapshot = this.fsmStateService.getSnapshot();
    const priceBySymbol = new Map(state.latestBinanceBySymbol);
    const symbolsToRender = this.getBinanceSymbols();
    for (const symbol of symbolsToRender) {
      const snap = snapshot.get(symbol) ?? persistedSnapshot.get(symbol);
      const fallbackThreshold = this.fsmStateService.getLastThreshold(symbol);
      const fsm = snap
        ? {
          ...this.defaultFsm(),
          state: snap.state,
          threshold: snap.threshold ?? fallbackThreshold,
          lastBUYThreshold: snap.lastBUYThreshold,
          lastSELLThreshold: snap.lastSELLThreshold
        }
        : {
          ...(state.fsmBySymbol.get(symbol) ?? this.defaultFsm()),
          threshold: fallbackThreshold ?? (state.fsmBySymbol.get(symbol)?.threshold ?? null)
        };
      const price = this.getBinancePriceForSymbol(symbol, priceBySymbol, snap?.ltp ?? null);
      if (!this.loggedMissingBtcThreshold && fsm.threshold === null) {
        this.loggedMissingBtcThreshold = true;
        this.log(
          `[btc-row] symbol=${symbol} price=${price ?? '--'} threshold=${fsm.threshold ?? '--'} state=${fsm.state}`
        );
      }
      rows.push(this.toStateRow(symbol, price, fsm, lotBySymbol));
    }
    return rows;
  }

  private logZerodhaRows(rows: TickRow[]): void {
    if (this.includeBinance || rows.length === 0) {
      return;
    }
    const now = Date.now();
    if (now - this.lastZerodhaLogAt < 5000) {
      return;
    }
    this.lastZerodhaLogAt = now;
    const symbols = rows.map((row) => row.symbol ?? '--').join(', ');
    this.log(`[zerodha6] rows=${rows.length} symbols=${symbols}`);
  }

  private getBinanceSymbols(): string[] {
    if (this.binanceSymbols && this.binanceSymbols.length > 0) {
      return this.binanceSymbols;
    }
    return ['BTCUSDT'];
  }

  private getBinancePriceForSymbol(
    symbol: string,
    latestBySymbol: Map<string, number>,
    snapshotLtp: number | null
  ): number | null {
    const direct = latestBySymbol.get(symbol);
    if (direct !== undefined) {
      return direct;
    }
    const persisted = this.fsmStateService.getLastPrice(symbol);
    if (persisted !== null) {
      return persisted;
    }
    if (symbol.endsWith('_LONG') || symbol.endsWith('_SHORT')) {
      const baseSymbol = symbol.replace(/_(LONG|SHORT)$/, '');
      const basePrice = latestBySymbol.get(baseSymbol);
      if (basePrice !== undefined) {
        return basePrice;
      }
      const basePersisted = this.fsmStateService.getLastPrice(baseSymbol);
      if (basePersisted !== null) {
        return basePersisted;
      }
    }
    return snapshotLtp ?? null;
  }

  private log(message: string): void {
    if (!this.enableLogs) {
      return;
    }
    console.log(message);
  }

  private logStuck(
    source: 'tick' | 'signal' | 'binance',
    symbol: string,
    current: InstrumentFsm,
    ltp: number | null,
    receivedAt: number,
    reason: string
  ): void {
    const lastLogAt = this.lastStuckLogAtBySymbol.get(symbol) ?? 0;
    if (receivedAt - lastLogAt < 10000) {
      return;
    }
    this.lastStuckLogAtBySymbol.set(symbol, receivedAt);
    this.log(
      `[tick] stuck source=${source} symbol=${symbol} state=${current.state} ltp=${ltp ?? '--'} threshold=${current.threshold ?? '--'} reason=${reason}`
    );
  }


  private loadInstrumentMap() {
    return defer(() => from(this.fetchInstrumentMap())).pipe(
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  private buildFsmSnapshot(state: TickState, lookup: InstrumentLookup): Map<string, FsmSymbolSnapshot> {
    const snapshot = new Map<string, FsmSymbolSnapshot>();
    for (const [token, fsm] of state.fsmByToken.entries()) {
      const zerodhaSymbol = lookup.map.get(token) ?? null;
      const symbols = zerodhaSymbol ? [zerodhaSymbol] : (lookup.tokenSymbols.get(token) ?? []);
      const ltp = state.latestLtpByToken.get(token) ?? null;
      for (const symbol of symbols) {
        snapshot.set(symbol, {
          state: fsm.state,
          ltp,
          threshold: fsm.threshold,
          lastBUYThreshold: fsm.lastBUYThreshold,
          lastSELLThreshold: fsm.lastSELLThreshold,
          lastBlockedAtMs: fsm.lastBlockedAtMs
        });
      }
    }
    for (const [symbol, fsm] of state.fsmBySymbol.entries()) {
      const ltp = state.latestBinanceBySymbol.get(symbol) ?? null;
      snapshot.set(symbol, {
        state: fsm.state,
        ltp,
        threshold: fsm.threshold,
        lastBUYThreshold: fsm.lastBUYThreshold,
        lastSELLThreshold: fsm.lastSELLThreshold,
        lastBlockedAtMs: fsm.lastBlockedAtMs
      });
    }
    return snapshot;
  }

  private async fetchInstrumentMap(): Promise<InstrumentLookup> {
    try {
      const response = await fetch('/instruments.json', { cache: 'no-store' });
      if (!response.ok) {
        return {
          map: new Map<number, string>(),
          order: new Map<number, number>(),
          symbolLookup: new Map<string, number>(),
          tokenSymbols: new Map<number, string[]>(),
          lotBySymbol: new Map<string, number>()
        };
      }
      const parsed = await response.json();
      const meta = Array.isArray(parsed) ? (parsed as InstrumentMeta[]) : [];
      return this.buildMapFromMeta(meta);
    } catch {
      return {
        map: new Map<number, string>(),
        order: new Map<number, number>(),
        symbolLookup: new Map<string, number>(),
        tokenSymbols: new Map<number, string[]>(),
        lotBySymbol: new Map<string, number>()
      };
    }
  }

  private buildMapFromMeta(meta: InstrumentMeta[]): InstrumentLookup {
    const map = new Map<number, string>();
    const order = new Map<number, number>();
    const symbolLookup = new Map<string, number>();
    const tokenSymbols = new Map<number, string[]>();
    const lotBySymbol = new Map<string, number>();
    meta.forEach((instrument, index) => {
      if (typeof instrument.token === 'number' && typeof instrument.zerodha === 'string') {
        map.set(instrument.token, instrument.zerodha);
        order.set(instrument.token, index);
        symbolLookup.set(instrument.zerodha, instrument.token);
        const list = tokenSymbols.get(instrument.token) ?? [];
        list.push(instrument.zerodha);
        tokenSymbols.set(instrument.token, list);
        if (typeof instrument.lot === 'number') {
          lotBySymbol.set(instrument.zerodha, instrument.lot);
        }
      }
      if (typeof instrument.token === 'number' && typeof instrument.tradingview === 'string') {
        symbolLookup.set(instrument.tradingview, instrument.token);
        const list = tokenSymbols.get(instrument.token) ?? [];
        list.push(instrument.tradingview);
        tokenSymbols.set(instrument.token, list);
        if (typeof instrument.lot === 'number') {
          lotBySymbol.set(instrument.tradingview, instrument.lot);
        }
      }
    });
    return { map, order, symbolLookup, tokenSymbols, lotBySymbol };
  }

  private computeQuantity(
    symbol: string | null,
    ltp: number | null,
    lotBySymbol: Map<string, number>
  ): number | null {
    if (!symbol || ltp === null) {
      return null;
    }
    const lot = this.getLotForSymbol(symbol, lotBySymbol);
    if (lot === null || lot <= 0) {
      return null;
    }
    const capital = this.relayService.getCapitalValue();
    const lots = Math.ceil(capital / (lot * ltp));
    return Math.max(1, lots) * lot;
  }

  private getLotForSymbol(symbol: string, lotBySymbol: Map<string, number>): number | null {
    if (lotBySymbol.has(symbol)) {
      return lotBySymbol.get(symbol) ?? null;
    }
    const base = symbol.replace(/_(LONG|SHORT)$/, '');
    return lotBySymbol.get(base) ?? null;
  }
}
