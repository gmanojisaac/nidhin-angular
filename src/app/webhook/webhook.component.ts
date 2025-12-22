import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatToolbarModule } from '@angular/material/toolbar';
import { combineLatest, defer, from, map, merge, scan, shareReplay, startWith, Subject, withLatestFrom } from 'rxjs';
import { FsmSymbolSnapshot, TickFsmStateService } from '../tick/tick-fsm-state.service';
import { WebhookPayload, WebhookService } from './webhook.service';

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
  liveTradesBySymbol: Map<string, TradeRow[]>;
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
  tradesBySymbol: Map<string, TradeRow[]>;
  cumulativeBySymbol: Map<string, number>;
  lastSnapshotBySymbol: Map<string, FsmSymbolSnapshot>;
};

type WebhookEvent =
  | { type: 'payload'; payload: WebhookPayload; snapshot: Map<string, FsmSymbolSnapshot> }
  | { type: 'clear' };

@Component({
  selector: 'app-webhook',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatTableModule,
    MatToolbarModule
  ],
  templateUrl: './webhook.component.html',
  styleUrl: './webhook.component.css'
})
export class WebhookComponent {
  private readonly webhookService = inject(WebhookService);
  private readonly fsmStateService = inject(TickFsmStateService);
  private readonly clearSignals$ = new Subject<void>();

  selectedSymbol = '';
  readonly displayedColumns = [
    'timeIst',
    'intent',
    'stoppx',
    'alternateSignal',
    'buySellSell',
    'sellBuyBuy'
  ];
  readonly tradeColumns = [
    'timeIst',
    'symbol',
    'entryPrice',
    'currentPrice',
    'unrealizedPnl',
    'cumulativePnl',
    'quantity'
  ];

  private readonly signalState$ = merge(
    this.webhookService.webhook$.pipe(
      withLatestFrom(this.fsmStateService.fsmBySymbol$),
      map(([payload, snapshot]) => ({ type: 'payload', payload, snapshot }) as WebhookEvent)
    ),
    this.clearSignals$.pipe(map(() => ({ type: 'clear' }) as WebhookEvent))
  ).pipe(
    scan((state, event) => {
      if (event.type === 'clear') {
        return this.initialSignalState();
      }
      return this.reduceSignalState(state, event.payload, event.snapshot);
    }, this.initialSignalState()),
    startWith(this.initialSignalState()),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private readonly lotLookup$ = this.loadLotLookup();

  private readonly tradeState$ = combineLatest([this.fsmStateService.fsmBySymbol$, this.lotLookup$]).pipe(
    scan(
      (state, [snapshot, lotLookup]) => this.reduceTradeState(state, snapshot, lotLookup),
      this.initialTradeState()
    ),
    startWith(this.initialTradeState()),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly viewModel$ = combineLatest([this.signalState$, this.tradeState$]).pipe(
    map(([signalState, tradeState]) => {
      const state = signalState;
      if (!this.selectedSymbol && state.symbols.length > 0) {
        this.selectedSymbol = state.symbols[0];
      }
      const activeSymbol = this.selectedSymbol;
      const rows = activeSymbol ? state.bySymbol.get(activeSymbol) ?? [] : [];
      const paperRows = activeSymbol ? tradeState.tradesBySymbol.get(activeSymbol) ?? [] : [];
      const liveRows = activeSymbol ? state.liveTradesBySymbol.get(activeSymbol) ?? [] : [];
      return {
        symbols: state.symbols,
        activeSymbol,
        rows,
        paperRows,
        liveRows
      };
    })
  );

  clearSignals(): void {
    this.selectedSymbol = '';
    this.clearSignals$.next();
  }

  formatStopPx(value: number | null): string {
    if (value === null || Number.isNaN(value)) {
      return '--';
    }
    return value.toFixed(2);
  }

  formatPrice(value: number | null): string {
    if (value === null || Number.isNaN(value)) {
      return '--';
    }
    return value.toFixed(2);
  }

  private initialSignalState(): SignalState {
    return {
      bySymbol: new Map<string, SignalRow[]>(),
      fsmBySymbol: new Map<string, SignalTracking>(),
      paperTradesBySymbol: new Map<string, TradeRow[]>(),
      liveTradesBySymbol: new Map<string, TradeRow[]>(),
      symbols: []
    };
  }

  private initialTradeState(): TradeState {
    return {
      openBySymbol: new Map<string, OpenTrade>(),
      tradesBySymbol: new Map<string, TradeRow[]>(),
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
    const tradesBySymbol = new Map(state.tradesBySymbol);
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
      const isEntering = prevState !== 'BUYPOSITION' && current.state === 'BUYPOSITION';
      const isExiting = prevState === 'BUYPOSITION' && current.state !== 'BUYPOSITION';

      if (isEntering) {
        const entryPrice = ltp;
        const lot = lotLookup.get(symbol) ?? 1;
        const quantity = Math.ceil(10000 / (lot * ltp));
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
      if (openTrade && current.state === 'BUYPOSITION') {
        const pnl = (ltp - openTrade.entryPrice) * openTrade.quantity * openTrade.lot;
        this.updateTradeRow(tradesBySymbol, symbol, openTrade.id, {
          currentPrice: ltp,
          unrealizedPnl: pnl
        });
        continue;
      }

      if (openTrade && isExiting) {
        const realized = (ltp - openTrade.entryPrice) * openTrade.quantity * openTrade.lot;
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
      }
    }

    return { openBySymbol, tradesBySymbol, cumulativeBySymbol, lastSnapshotBySymbol };
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

  private loadLotLookup() {
    return defer(() => from(this.fetchLotLookup())).pipe(
      shareReplay({ bufferSize: 1, refCount: true })
    );
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
    snapshot: Map<string, FsmSymbolSnapshot>
  ): SignalState {
    const symbol = typeof payload.symbol === 'string' ? payload.symbol : '';
    if (!symbol) {
      return state;
    }
    const intent = this.normalizeString(payload.intent);
    const signal = this.getSignalType(intent, this.normalizeString(payload.side));
    const tracking = state.fsmBySymbol.get(symbol) ?? this.defaultTracking();
    const nextTracking = this.nextTracking(tracking, signal, snapshot.get(symbol));
    const nextRow: SignalRow = {
      timeIst: this.formatIstTime(new Date()),
      intent,
      stoppx: typeof payload.stoppx === 'number' ? payload.stoppx : null,
      alternateSignal: nextTracking.alternateSignal,
      buySellSell: nextTracking.buySellSell,
      sellBuyBuy: nextTracking.sellBuyBuy
    };
    const bySymbol = new Map(state.bySymbol);
    const existingRows = bySymbol.get(symbol) ?? [];
    const nextRows = [nextRow, ...existingRows].slice(0, 50);
    bySymbol.set(symbol, nextRows);
    const fsmBySymbol = new Map(state.fsmBySymbol);
    fsmBySymbol.set(symbol, nextTracking.state);
    const symbols = state.symbols.includes(symbol)
      ? state.symbols
      : [...state.symbols, symbol];
    return {
      bySymbol,
      fsmBySymbol,
      paperTradesBySymbol: state.paperTradesBySymbol,
      liveTradesBySymbol: state.liveTradesBySymbol,
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
    if (candidate === 'BUY') {
      return 'BUY';
    }
    if (candidate === 'SELL') {
      return 'SELL';
    }
    return null;
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
}
