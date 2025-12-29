import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, combineLatest, defer, from, map, shareReplay, withLatestFrom } from 'rxjs';
import { FsmSymbolSnapshot, TickFsmStateService } from '../tick/tick-fsm-state.service';
import { WebhookPayload, WebhookService } from './webhook.service';

export type FilterMode = 'zerodha6' | 'btc' | 'btc-long' | 'btc-short' | 'none';

type SignalRow = {
  timeIst: string;
  intent: string | null;
  stoppx: number | null;
  alternateSignal: boolean;
  buySellSell: boolean;
  sellBuyBuy: boolean;
};

type InstrumentMeta = {
  tradingview?: string;
  zerodha?: string;
  lot?: number;
};

type SignalState = {
  bySymbol: Map<string, SignalRow[]>;
  fsmBySymbol: Map<string, SignalTracking>;
  paperTradesBySymbol: Map<string, TradeRow[]>;
  symbols: string[];
};

type SignalTracking = {
  lastSignal: 'BUY' | 'SELL' | null;
  sellAfterBuyCount: number;
  buyAfterSellCount: number;
  alternateSignal: boolean;
  buySellSell: boolean;
  sellBuyBuy: boolean;
};

type TradeRow = {
  id: string;
  timeIst: string;
  symbol: string;
  entryPrice: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  cumulativePnl: number | null;
  quantity: number | null;
};

type OpenTrade = {
  id: string;
  symbol: string;
  entryPrice: number;
  quantity: number;
  lot: number;
  timeIst: string;
};

type TradeState = {
  openBySymbol: Map<string, OpenTrade>;
  liveOpenBySymbol: Map<string, OpenTrade>;
  tradesBySymbol: Map<string, TradeRow[]>;
  liveTradesBySymbol: Map<string, TradeRow[]>;
  cumulativeBySymbol: Map<string, number>;
  lastSnapshotBySymbol: Map<string, FsmSymbolSnapshot>;
};

@Injectable({ providedIn: 'root' })
export class WebhookStateService {
  private readonly webhookService = inject(WebhookService);
  private readonly fsmStateService = inject(TickFsmStateService);
  private readonly debugStateUpdates = true;
  private readonly instanceId = Math.random().toString(36).slice(2, 7);
  private readonly loggedModes = new Set<FilterMode>();
  private readonly signalStateByMode = new Map<FilterMode, BehaviorSubject<SignalState>>();
  private readonly tradeState$ = new BehaviorSubject<TradeState>(this.initialTradeState());
  private readonly lastPnlLogMinuteBySymbol = new Map<string, number>();
  private readonly lastLiveTradeIdBySymbol = new Map<string, string>();
  private readonly liveTradeBlockedUntilBySymbol = new Map<string, number>();
  private readonly lastLiveEntryMinuteBySymbol = new Map<string, number>();
  private readonly zerodhaSellCountAfterBuyBySymbol = new Map<string, number>();
  private readonly zerodhaPendingBuySellSellBySymbol = new Set<string>();
  private readonly allowedSymbolsByMode$ = defer(() => from(this.fetchAllowedSymbolsByMode())).pipe(
    shareReplay({ bufferSize: 1, refCount: false })
  );
  private readonly lotLookup$ = defer(() => from(this.fetchLotLookup())).pipe(
    shareReplay({ bufferSize: 1, refCount: false })
  );

  constructor() {
    console.log(`[webhook-state] init instance=${this.instanceId}`);
    const modes: FilterMode[] = ['none', 'zerodha6', 'btc', 'btc-long', 'btc-short'];
    for (const mode of modes) {
      this.signalStateByMode.set(mode, new BehaviorSubject<SignalState>(this.initialSignalState()));
    }

    this.webhookService.webhook$.pipe(
      withLatestFrom(this.fsmStateService.fsmBySymbol$, this.allowedSymbolsByMode$)
    ).subscribe(([payload, snapshot, allowedByMode]) => {
      for (const mode of modes) {
        const allowed = allowedByMode.get(mode) ?? null;
        const subject = this.signalStateByMode.get(mode);
        if (!subject) {
          continue;
        }
        const next = this.reduceSignalState(subject.value, payload, snapshot, allowed, mode);
        if (next !== subject.value) {
          if (this.debugStateUpdates) {
            const rows = next.bySymbol.get(next.symbols[0] ?? '')?.length ?? 0;
            console.log(
              `[webhook-state] state updated mode=${mode} symbols=${next.symbols.length} rows=${rows}`
            );
          }
          subject.next(next);
        }
      }
    });

    combineLatest([this.fsmStateService.fsmBySymbol$, this.lotLookup$]).pipe(
      map(([snapshot, lotLookup]) => this.reduceTradeState(this.tradeState$.value, snapshot, lotLookup))
    ).subscribe((next) => {
      this.tradeState$.next(next);
    });
  }

  signalState$(mode: FilterMode) {
    const subject = this.signalStateByMode.get(mode) ?? this.signalStateByMode.get('none');
    if (!subject) {
      return new BehaviorSubject<SignalState>(this.initialSignalState()).asObservable();
    }
    if (!this.loggedModes.has(mode)) {
      this.loggedModes.add(mode);
      const current = subject.value;
      const rows = current.bySymbol.get(current.symbols[0] ?? '')?.length ?? 0;
      console.log(
        `[webhook-state] subscribe instance=${this.instanceId} mode=${mode} symbols=${current.symbols.length} rows=${rows}`
      );
    }
    return subject.asObservable();
  }

  getTradeState$() {
    return this.tradeState$.asObservable();
  }

  clearSignals(mode: FilterMode): void {
    const subject = this.signalStateByMode.get(mode);
    if (subject) {
      subject.next(this.initialSignalState());
    }
  }

  private initialSignalState(): SignalState {
    return {
      bySymbol: new Map<string, SignalRow[]>(),
      fsmBySymbol: new Map<string, SignalTracking>(),
      paperTradesBySymbol: new Map<string, TradeRow[]>(),
      symbols: []
    };
  }

  private initialTradeState(): TradeState {
    return {
      openBySymbol: new Map<string, OpenTrade>(),
      liveOpenBySymbol: new Map<string, OpenTrade>(),
      tradesBySymbol: new Map<string, TradeRow[]>(),
      liveTradesBySymbol: new Map<string, TradeRow[]>(),
      cumulativeBySymbol: new Map<string, number>(),
      lastSnapshotBySymbol: new Map<string, FsmSymbolSnapshot>()
    };
  }

  private reduceTradeState(
    state: TradeState,
    snapshot: Map<string, FsmSymbolSnapshot>,
    lotLookup: Map<string, number>
  ): TradeState {
    const openBySymbol = new Map(state.openBySymbol);
    const liveOpenBySymbol = new Map(state.liveOpenBySymbol);
    const tradesBySymbol = new Map(state.tradesBySymbol);
    const liveTradesBySymbol = new Map(state.liveTradesBySymbol);
    const cumulativeBySymbol = new Map(state.cumulativeBySymbol);
    const lastSnapshotBySymbol = new Map(state.lastSnapshotBySymbol);

    for (const [symbol, current] of snapshot.entries()) {
      const prev = lastSnapshotBySymbol.get(symbol);
      lastSnapshotBySymbol.set(symbol, current);
      if (!current.ltp) {
        continue;
      }
      const ltp = current.ltp;
      const prevState = prev?.state ?? 'NOSIGNAL';
      const wasInPosition = this.isPositionState(prevState);
      const isInPosition = this.isPositionState(current.state);
      const isEntering = !wasInPosition && isInPosition;
      const isExiting = wasInPosition && !isInPosition;

      if (this.zerodhaPendingBuySellSellBySymbol.has(symbol)) {
        if (!isInPosition && current.lastBUYThreshold !== null && current.ltp !== null) {
          if (current.ltp < current.lastBUYThreshold && current.threshold !== current.lastBUYThreshold) {
            const nextSnapshot = new Map<string, FsmSymbolSnapshot>();
            nextSnapshot.set(symbol, { ...current, threshold: current.lastBUYThreshold });
            this.fsmStateService.update(nextSnapshot);
            this.resetCumulativePnl(symbol);
            this.zerodhaPendingBuySellSellBySymbol.delete(symbol);
            this.zerodhaSellCountAfterBuyBySymbol.set(symbol, 0);
            console.log(
              `[zerodha6] buySellSell reset symbol=${symbol} ltp=${current.ltp} threshold=${current.lastBUYThreshold}`
            );
          }
        }
      }

      if (isEntering) {
        const entryPrice = ltp;
        const lot = lotLookup.get(symbol) ?? 1;
        const quantity = Math.ceil(100000 / (lot * ltp));
        const timeIst = this.formatIstTime(new Date());
        const id = `${symbol}-${Date.now()}`;
        const openTrade: OpenTrade = { id, symbol, entryPrice, quantity, lot, timeIst };
        openBySymbol.set(symbol, openTrade);
        const row: TradeRow = {
          id,
          timeIst,
          symbol,
          entryPrice,
          currentPrice: ltp,
          unrealizedPnl: 0,
          cumulativePnl: cumulativeBySymbol.get(symbol) ?? 0,
          quantity
        };
        const existing = tradesBySymbol.get(symbol) ?? [];
        tradesBySymbol.set(symbol, [row, ...existing]);
        continue;
      }

      const openTrade = openBySymbol.get(symbol);
      const liveOpenTrade = liveOpenBySymbol.get(symbol);
      if (openTrade && isInPosition) {
        const paperUnrealized = this.calculatePnl(symbol, ltp, openTrade.entryPrice, openTrade.quantity, openTrade.lot);
        const cumulative = cumulativeBySymbol.get(symbol) ?? 0;
        this.updateTradeRow(tradesBySymbol, symbol, openTrade.id, {
          currentPrice: ltp,
          unrealizedPnl: paperUnrealized
        });

        if (liveOpenTrade) {
          const liveUnrealized = this.calculatePnl(
            symbol,
            ltp,
            liveOpenTrade.entryPrice,
            liveOpenTrade.quantity,
            liveOpenTrade.lot
          );
          if (paperUnrealized + cumulative < 0) {
            this.closeLiveTradeOnly(symbol, liveOpenTrade, ltp, liveUnrealized, liveTradesBySymbol, cumulative);
            liveOpenBySymbol.delete(symbol);
            this.blockLiveTrade(symbol);
          } else {
            this.updateTradeRow(liveTradesBySymbol, symbol, liveOpenTrade.id, {
              currentPrice: ltp,
              unrealizedPnl: liveUnrealized
            });
          }
        } else if (this.shouldEnterLiveTrade(symbol, cumulative, paperUnrealized)) {
          const now = new Date();
          const shouldEnterNow = isEntering || this.isMinuteBoundary(now);
          if (shouldEnterNow && this.shouldEnterOncePerMinute(symbol, now)) {
            const liveTrade = this.createLiveOpenTrade(symbol, openTrade, ltp, now);
            liveOpenBySymbol.set(symbol, liveTrade);
            this.appendLiveEntryRow(liveTradesBySymbol, liveTrade, ltp, cumulative);
          }
        }
      }

      if (openTrade && isExiting) {
        const realized = this.calculatePnl(symbol, ltp, openTrade.entryPrice, openTrade.quantity, openTrade.lot);
        const cumulative = (cumulativeBySymbol.get(symbol) ?? 0) + realized;
        cumulativeBySymbol.set(symbol, cumulative);
        this.updateTradeRow(tradesBySymbol, symbol, openTrade.id, {
          currentPrice: ltp,
          unrealizedPnl: 0,
          cumulativePnl: cumulative
        });
        const exitRow: TradeRow = {
          id: `${openTrade.id}-exit`,
          timeIst: this.formatIstTime(new Date()),
          symbol,
          entryPrice: openTrade.entryPrice,
          currentPrice: ltp,
          unrealizedPnl: realized,
          cumulativePnl: cumulative,
          quantity: openTrade.quantity
        };
        const existing = tradesBySymbol.get(symbol) ?? [];
        tradesBySymbol.set(symbol, [exitRow, ...existing]);
        openBySymbol.delete(symbol);
        if (liveOpenTrade) {
          const liveUnrealized = this.calculatePnl(
            symbol,
            ltp,
            liveOpenTrade.entryPrice,
            liveOpenTrade.quantity,
            liveOpenTrade.lot
          );
          this.closeLiveTradeOnly(symbol, liveOpenTrade, ltp, liveUnrealized, liveTradesBySymbol, cumulative);
          liveOpenBySymbol.delete(symbol);
        }
      }
    }

    this.logMinutePnl(snapshot, openBySymbol);
    return {
      openBySymbol,
      liveOpenBySymbol,
      tradesBySymbol,
      liveTradesBySymbol,
      cumulativeBySymbol,
      lastSnapshotBySymbol
    };
  }

  private updateTradeRow(
    tradesBySymbol: Map<string, TradeRow[]>,
    symbol: string,
    id: string,
    patch: Partial<TradeRow>
  ): void {
    const rows = tradesBySymbol.get(symbol);
    if (!rows || rows.length === 0) {
      return;
    }
    const next = rows.map((row) => {
      if ((row as { id?: string }).id === id) {
        return { ...row, ...patch };
      }
      return row;
    });
    tradesBySymbol.set(symbol, next);
  }

  private shouldEnterLiveTrade(symbol: string, cumulativePnl: number, unrealizedPnl: number): boolean {
    const now = Date.now();
    const blockedUntil = this.liveTradeBlockedUntilBySymbol.get(symbol) ?? 0;
    if (now < blockedUntil) {
      return false;
    }
    return cumulativePnl === 0 || (unrealizedPnl + cumulativePnl) > 0;
  }

  private closeLiveTradeOnly(
    symbol: string,
    openTrade: OpenTrade,
    ltp: number,
    unrealized: number,
    liveTradesBySymbol: Map<string, TradeRow[]>,
    cumulativePnl: number
  ): void {
    this.updateTradeRow(liveTradesBySymbol, symbol, openTrade.id, {
      currentPrice: ltp,
      unrealizedPnl: 0,
      cumulativePnl
    });
    const exitRow: TradeRow = {
      id: `${openTrade.id}-exit`,
      timeIst: this.formatIstTime(new Date()),
      symbol,
      entryPrice: openTrade.entryPrice,
      currentPrice: ltp,
      unrealizedPnl: unrealized,
      cumulativePnl,
      quantity: openTrade.quantity
    };
    const existing = liveTradesBySymbol.get(symbol) ?? [];
    liveTradesBySymbol.set(symbol, [exitRow, ...existing]);
    this.lastLiveTradeIdBySymbol.delete(symbol);
    console.log(`[live-trade] close symbol=${symbol} id=${openTrade.id}`);
  }

  private blockLiveTrade(symbol: string, now: Date = new Date()): void {
    const nextMinute = new Date(now);
    nextMinute.setSeconds(0, 0);
    nextMinute.setMinutes(nextMinute.getMinutes() + 1);
    this.liveTradeBlockedUntilBySymbol.set(symbol, nextMinute.getTime());
  }

  private createLiveOpenTrade(symbol: string, paperTrade: OpenTrade, ltp: number, now: Date): OpenTrade {
    return {
      id: `live-${symbol}-${now.getTime()}`,
      symbol,
      entryPrice: ltp,
      quantity: paperTrade.quantity,
      lot: paperTrade.lot,
      timeIst: this.formatIstTime(now)
    };
  }

  private appendLiveEntryRow(
    liveTradesBySymbol: Map<string, TradeRow[]>,
    liveTrade: OpenTrade,
    ltp: number,
    cumulativePnl: number
  ): void {
    const row: TradeRow = {
      id: liveTrade.id,
      timeIst: liveTrade.timeIst,
      symbol: liveTrade.symbol,
      entryPrice: liveTrade.entryPrice,
      currentPrice: ltp,
      unrealizedPnl: 0,
      cumulativePnl,
      quantity: liveTrade.quantity
    };
    const existing = liveTradesBySymbol.get(liveTrade.symbol) ?? [];
    liveTradesBySymbol.set(liveTrade.symbol, [row, ...existing]);
    this.lastLiveTradeIdBySymbol.set(liveTrade.symbol, liveTrade.id);
    console.log(
      `[live-trade] open symbol=${liveTrade.symbol} id=${liveTrade.id} entry=${row.entryPrice ?? '--'} qty=${row.quantity ?? '--'} lot=${liveTrade.lot}`
    );
  }

  private isMinuteBoundary(now: Date): boolean {
    return now.getSeconds() === 0;
  }

  private shouldEnterOncePerMinute(symbol: string, now: Date): boolean {
    const minute = Math.floor(now.getTime() / 60000);
    const lastMinute = this.lastLiveEntryMinuteBySymbol.get(symbol) ?? -1;
    if (minute === lastMinute) {
      return false;
    }
    this.lastLiveEntryMinuteBySymbol.set(symbol, minute);
    return true;
  }

  private async fetchLotLookup(): Promise<Map<string, number>> {
    try {
      const response = await fetch('/instruments.json', { cache: 'no-store' });
      if (!response.ok) {
        return new Map<string, number>();
      }
      const parsed = await response.json();
      const meta = Array.isArray(parsed) ? (parsed as InstrumentMeta[]) : [];
      const map = new Map<string, number>();
      for (const instrument of meta) {
        if (typeof instrument.lot === 'number') {
          if (typeof instrument.zerodha === 'string') {
            map.set(instrument.zerodha, instrument.lot);
          }
          if (typeof instrument.tradingview === 'string') {
            map.set(instrument.tradingview, instrument.lot);
          }
        }
      }
      return map;
    } catch {
      return new Map<string, number>();
    }
  }

  private reduceSignalState(
    state: SignalState,
    payload: WebhookPayload,
    snapshot: Map<string, FsmSymbolSnapshot>,
    allowedSymbols: Set<string> | null,
    mode: FilterMode
  ): SignalState {
    const symbol = typeof payload.symbol === 'string' ? payload.symbol : '';
    if (!symbol) {
      return state;
    }
    if (allowedSymbols && !allowedSymbols.has(symbol)) {
      return state;
    }
    const intent = this.normalizeString(payload.intent);
    const signal = this.getSignalType(intent, this.normalizeString(payload.side));
    if (!this.isSignalAllowed(mode, signal)) {
      return state;
    }
    const symbolKey = this.mapSymbolForMode(symbol, mode);
    const tracking = state.fsmBySymbol.get(symbolKey) ?? this.defaultTracking();
    const nextTracking = this.isBtcMode(mode)
      ? {
        state: this.defaultTracking(),
        alternateSignal: false,
        buySellSell: false,
        sellBuyBuy: false
      }
      : this.isZerodhaMode(mode)
        ? this.nextZerodhaTracking(tracking, signal, symbolKey, snapshot.get(symbolKey))
        : this.nextTracking(tracking, signal, snapshot.get(symbolKey));
    const nextRow: SignalRow = {
      timeIst: this.formatIstTime(new Date()),
      intent,
      stoppx: typeof payload.stoppx === 'number' ? payload.stoppx : null,
      alternateSignal: nextTracking.alternateSignal,
      buySellSell: nextTracking.buySellSell,
      sellBuyBuy: nextTracking.sellBuyBuy
    };
    const bySymbol = new Map(state.bySymbol);
    const existingRows = bySymbol.get(symbolKey) ?? [];
    const nextRows = [nextRow, ...existingRows].slice(0, 50);
    bySymbol.set(symbolKey, nextRows);
    const fsmBySymbol = new Map(state.fsmBySymbol);
    fsmBySymbol.set(symbolKey, nextTracking.state);
    const symbols = state.symbols.includes(symbolKey)
      ? state.symbols
      : [...state.symbols, symbolKey];
    return {
      bySymbol,
      fsmBySymbol,
      paperTradesBySymbol: state.paperTradesBySymbol,
      symbols
    };
  }

  private normalizeString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }

  private formatIstTime(value: Date): string {
    return value.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false
    });
  }

  private defaultTracking(): SignalTracking {
    return {
      lastSignal: null,
      sellAfterBuyCount: 0,
      buyAfterSellCount: 0,
      alternateSignal: false,
      buySellSell: false,
      sellBuyBuy: false
    };
  }

  private getSignalType(intent: string | null, side: string | null): 'BUY' | 'SELL' | null {
    const candidate = `${intent ?? side ?? ''}`.toUpperCase();
    if (candidate === 'BUY' || candidate === 'ENTRY') {
      return 'BUY';
    }
    if (candidate === 'SELL' || candidate === 'EXIT') {
      return 'SELL';
    }
    return null;
  }

  private isSignalAllowed(mode: FilterMode, signal: 'BUY' | 'SELL' | null): boolean {
    if (mode === 'btc-long') {
      return signal === 'BUY';
    }
    if (mode === 'btc-short') {
      return signal === 'SELL';
    }
    return true;
  }

  private isBtcMode(mode: FilterMode): boolean {
    return mode === 'btc' || mode === 'btc-long' || mode === 'btc-short';
  }

  private isZerodhaMode(mode: FilterMode): boolean {
    return mode === 'zerodha6';
  }

  private nextZerodhaTracking(
    tracking: SignalTracking,
    signal: 'BUY' | 'SELL' | null,
    symbol: string,
    snapshot: FsmSymbolSnapshot | undefined
  ) {
    const alternateSignalNow = tracking.lastSignal !== null && signal !== null && tracking.lastSignal !== signal;
    if (alternateSignalNow) {
      this.resetCumulativePnl(symbol);
    }

    const sellCountAfterBuy = this.updateZerodhaSellAfterBuyCount(symbol, signal, tracking.lastSignal);
    let buySellSell = sellCountAfterBuy >= 2;
    if (buySellSell) {
      this.zerodhaPendingBuySellSellBySymbol.add(symbol);
    }

    if (this.applyZerodhaBuySellSell(symbol, snapshot)) {
      buySellSell = false;
    }

    return {
      state: {
        lastSignal: signal ?? tracking.lastSignal,
        sellAfterBuyCount: 0,
        buyAfterSellCount: sellCountAfterBuy,
        alternateSignal: false,
        buySellSell,
        sellBuyBuy: false
      },
      alternateSignal: false,
      buySellSell,
      sellBuyBuy: false
    };
  }

  private updateZerodhaSellAfterBuyCount(
    symbol: string,
    signal: 'BUY' | 'SELL' | null,
    lastSignal: 'BUY' | 'SELL' | null
  ): number {
    const current = this.zerodhaSellCountAfterBuyBySymbol.get(symbol) ?? 0;
    if (signal === 'SELL') {
      if (lastSignal === 'BUY' || current > 0) {
        const next = current + 1;
        this.zerodhaSellCountAfterBuyBySymbol.set(symbol, next);
        return next;
      }
      return current;
    }
    if (signal === 'BUY') {
      this.zerodhaSellCountAfterBuyBySymbol.set(symbol, 0);
      return 0;
    }
    return current;
  }

  private applyZerodhaBuySellSell(symbol: string, snapshot: FsmSymbolSnapshot | undefined): boolean {
    if (!this.zerodhaPendingBuySellSellBySymbol.has(symbol)) {
      return false;
    }
    if (!snapshot || this.isPositionState(snapshot.state)) {
      return false;
    }
    if (snapshot.lastBUYThreshold === null || snapshot.ltp === null) {
      return false;
    }
    if (snapshot.ltp >= snapshot.lastBUYThreshold) {
      return false;
    }
    const nextSnapshot = new Map<string, FsmSymbolSnapshot>();
    nextSnapshot.set(symbol, {
      ...snapshot,
      threshold: snapshot.lastBUYThreshold
    });
    this.fsmStateService.update(nextSnapshot);
    this.resetCumulativePnl(symbol);
    this.zerodhaPendingBuySellSellBySymbol.delete(symbol);
    this.zerodhaSellCountAfterBuyBySymbol.set(symbol, 0);
    return true;
  }

  private resetCumulativePnl(symbol: string): void {
    const current = this.tradeState$.value;
    if (!current.cumulativeBySymbol.has(symbol)) {
      return;
    }
    const next = new Map(current.cumulativeBySymbol);
    next.set(symbol, 0);
    this.tradeState$.next({
      ...current,
      cumulativeBySymbol: next
    });
  }

  private isPositionState(state: FsmSymbolSnapshot['state']): boolean {
    return state === 'BUYPOSITION' || state === 'SELLPOSITION';
  }

  private mapSymbolForMode(symbol: string, mode: FilterMode): string {
    const upper = symbol.toUpperCase();
    if (mode === 'btc-long' && (upper === 'BTCUSDT' || upper === 'BTCUSD')) {
      return 'BTCUSDT_LONG';
    }
    if (mode === 'btc-short' && (upper === 'BTCUSDT' || upper === 'BTCUSD')) {
      return 'BTCUSDT_SHORT';
    }
    return symbol;
  }

  private nextTracking(
    tracking: SignalTracking,
    signal: 'BUY' | 'SELL' | null,
    snapshot: FsmSymbolSnapshot | undefined
  ) {
    const alternateSignalNow = tracking.lastSignal !== null && signal !== null && tracking.lastSignal !== signal;
    const alternateSignal = tracking.alternateSignal || alternateSignalNow;
    let sellAfterBuyCount = tracking.sellAfterBuyCount;
    let buyAfterSellCount = tracking.buyAfterSellCount;
    if (signal === 'SELL') {
      sellAfterBuyCount = tracking.lastSignal === 'BUY' ? tracking.sellAfterBuyCount + 1 : 0;
      buyAfterSellCount = 0;
    } else if (signal === 'BUY') {
      buyAfterSellCount = tracking.lastSignal === 'SELL' ? tracking.buyAfterSellCount + 1 : 0;
      sellAfterBuyCount = 0;
    }
    const snapshotLtp = snapshot?.ltp ?? null;
    const canUseSnapshot = snapshot?.state === 'NOPOSITION_SIGNAL' && snapshotLtp !== null;
    const buySellSellEligible = signal === 'SELL'
      && sellAfterBuyCount >= 2
      && canUseSnapshot
      && snapshot.lastBUYThreshold !== null
      && snapshotLtp < snapshot.lastBUYThreshold;
    const sellBuyBuyEligible = signal === 'BUY'
      && buyAfterSellCount >= 2
      && canUseSnapshot
      && snapshot.lastSELLThreshold !== null
      && snapshotLtp < snapshot.lastSELLThreshold;
    const buySellSell = tracking.buySellSell || buySellSellEligible;
    const sellBuyBuy = tracking.sellBuyBuy || sellBuyBuyEligible;
    const state: SignalTracking = {
      lastSignal: signal ?? tracking.lastSignal,
      sellAfterBuyCount,
      buyAfterSellCount,
      alternateSignal,
      buySellSell,
      sellBuyBuy
    };
    return { state, alternateSignal, buySellSell, sellBuyBuy };
  }

  private async fetchAllowedSymbolsByMode(): Promise<Map<FilterMode, Set<string> | null>> {
    const result = new Map<FilterMode, Set<string> | null>();
    result.set('none', null);
    try {
      const response = await fetch('/instruments.json', { cache: 'no-store' });
      if (!response.ok) {
        result.set('zerodha6', null);
        result.set('btc', new Set(['BTCUSDT']));
        result.set('btc-long', new Set(['BTCUSDT', 'BTCUSD']));
        result.set('btc-short', new Set(['BTCUSDT', 'BTCUSD']));
        return result;
      }
      const parsed = await response.json();
      const meta = Array.isArray(parsed) ? (parsed as InstrumentMeta[]) : [];

      const btc = new Set<string>();
      for (const instrument of meta) {
        if (instrument.tradingview === 'BTCUSDT' || instrument.zerodha === 'BTCUSD') {
          if (typeof instrument.tradingview === 'string') {
            btc.add(instrument.tradingview);
          }
          if (typeof instrument.zerodha === 'string') {
            btc.add(instrument.zerodha);
          }
        }
      }
      if (btc.size === 0) {
        btc.add('BTCUSDT');
      }
      result.set('btc', btc);
      result.set('btc-long', new Set(btc));
      result.set('btc-short', new Set(btc));

      const symbols = new Set<string>();
      let count = 0;
      for (const instrument of meta) {
        if (count >= 6) {
          break;
        }
        if (instrument.tradingview === 'BTCUSDT' || instrument.zerodha === 'BTCUSD') {
          continue;
        }
        if (typeof instrument.zerodha === 'string') {
          symbols.add(instrument.zerodha);
        }
        if (typeof instrument.tradingview === 'string') {
          symbols.add(instrument.tradingview);
        }
        count += 1;
      }
      result.set('zerodha6', symbols);
      return result;
    } catch {
      result.set('zerodha6', null);
      result.set('btc', new Set(['BTCUSDT']));
      result.set('btc-long', new Set(['BTCUSDT', 'BTCUSD']));
      result.set('btc-short', new Set(['BTCUSDT', 'BTCUSD']));
      return result;
    }
  }

  private logMinutePnl(
    snapshot: Map<string, FsmSymbolSnapshot>,
    openBySymbol: Map<string, OpenTrade>
  ): void {
    const now = new Date();
    if (now.getSeconds() < 59) {
      return;
    }
    const minute = Math.floor(now.getTime() / 60000);
    for (const [symbol, trade] of openBySymbol.entries()) {
      const current = snapshot.get(symbol);
      if (!current || !this.isPositionState(current.state) || current.ltp === null) {
        continue;
      }
      const lastMinute = this.lastPnlLogMinuteBySymbol.get(symbol) ?? -1;
      if (lastMinute >= minute) {
        continue;
      }
      const pnl = this.calculatePnl(symbol, current.ltp, trade.entryPrice, trade.quantity, trade.lot);
      this.lastPnlLogMinuteBySymbol.set(symbol, minute);
      console.log(
        `[pnl-minute] symbol=${symbol} pnl=${pnl.toFixed(2)} ltp=${current.ltp.toFixed(2)} entry=${trade.entryPrice.toFixed(2)} qty=${trade.quantity} lot=${trade.lot}`
      );
    }
  }

  private calculatePnl(
    symbol: string,
    ltp: number,
    entryPrice: number,
    quantity: number,
    lot: number
  ): number {
    const isShort = symbol === 'BTCUSDT_SHORT';
    const delta = isShort ? entryPrice - ltp : ltp - entryPrice;
    return delta * quantity * lot;
  }
}
