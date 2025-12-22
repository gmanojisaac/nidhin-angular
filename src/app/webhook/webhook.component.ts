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
import { map, merge, scan, shareReplay, startWith, Subject } from 'rxjs';
import { WebhookPayload, WebhookService } from './webhook.service';

type SignalRow = {
  timeIst: string;
  intent: string | null;
  stoppx: number | null;
  alternateSignal: boolean;
  buySellSell: boolean;
  sellBuyBuy: boolean;
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
  timeIst: string;
  ltp: number | null;
  unrealizedPnl: number | null;
  cumulativePnl: number | null;
  quantity: number | null;
};

type WebhookEvent =
  | { type: 'payload'; payload: WebhookPayload }
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
    'ltp',
    'unrealizedPnl',
    'cumulativePnl',
    'quantity'
  ];

  private readonly signalState$ = merge(
    this.webhookService.webhook$.pipe(map((payload) => ({ type: 'payload', payload }) as WebhookEvent)),
    this.clearSignals$.pipe(map(() => ({ type: 'clear' }) as WebhookEvent))
  ).pipe(
    scan((state, event) => {
      if (event.type === 'clear') {
        return this.initialSignalState();
      }
      return this.reduceSignalState(state, event.payload);
    }, this.initialSignalState()),
    startWith(this.initialSignalState()),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly viewModel$ = this.signalState$.pipe(
    map((state) => {
      if (!this.selectedSymbol && state.symbols.length > 0) {
        this.selectedSymbol = state.symbols[0];
      }
      const activeSymbol = this.selectedSymbol;
      const rows = activeSymbol ? state.bySymbol.get(activeSymbol) ?? [] : [];
      const paperRows = activeSymbol ? state.paperTradesBySymbol.get(activeSymbol) ?? [] : [];
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

  private initialSignalState(): SignalState {
    return {
      bySymbol: new Map<string, SignalRow[]>(),
      fsmBySymbol: new Map<string, SignalTracking>(),
      paperTradesBySymbol: new Map<string, TradeRow[]>(),
      liveTradesBySymbol: new Map<string, TradeRow[]>(),
      symbols: []
    };
  }

  private reduceSignalState(state: SignalState, payload: WebhookPayload): SignalState {
    const symbol = typeof payload.symbol === 'string' ? payload.symbol : '';
    if (!symbol) {
      return state;
    }
    const intent = this.normalizeString(payload.intent);
    const signal = this.getSignalType(intent, this.normalizeString(payload.side));
    const tracking = state.fsmBySymbol.get(symbol) ?? this.defaultTracking();
    const nextTracking = this.nextTracking(tracking, signal);
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

  private nextTracking(tracking: SignalTracking, signal: 'BUY' | 'SELL' | null) {
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
    const buySellSell = tracking.buySellSell || (signal === 'SELL' && sellAfterBuyCount >= 2);
    const sellBuyBuy = tracking.sellBuyBuy || (signal === 'BUY' && buyAfterSellCount >= 2);
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
