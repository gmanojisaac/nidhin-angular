import { Injectable, inject } from '@angular/core';
import { RelayService } from '../relay/relay.service';
import { TickFsmStateService } from '../tick/tick-fsm-state.service';
import { WebhookStateService } from '../webhook/webhook-state.service';

type SignalRow = {
  timeIst: string;
  intent: string | null;
  stoppx: number | null;
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

type TickRow = {
  symbol: string;
  ltp: number | null;
  threshold: number | null;
  quantity: number | null;
  noSignal: boolean;
  noPositionSignal: boolean;
  buyPosition: boolean;
  noPositionBlocked: boolean;
};

export type HistoryBtcSnapshot = {
  dateKey: string;
  capturedAt: string;
  symbols: string[];
  signalsBySymbol: Record<string, SignalRow[]>;
  paperTradesBySymbol: Record<string, TradeRow[]>;
  liveTradesBySymbol: Record<string, TradeRow[]>;
  ticks: TickRow[];
};

type InstrumentMeta = {
  tradingview?: string;
  zerodha?: string;
  lot?: number;
};

@Injectable({ providedIn: 'root' })
export class HistoryBtcService {
  private readonly webhookStateService = inject(WebhookStateService);
  private readonly tickFsmStateService = inject(TickFsmStateService);
  private readonly relayService = inject(RelayService);
  private readonly storageKey = 'history-btc-latest';

  getLatestSnapshot(): HistoryBtcSnapshot | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as HistoryBtcSnapshot;
    } catch {
      return null;
    }
  }

  async captureSnapshot(dateKey: string, capturedAt = new Date()): Promise<HistoryBtcSnapshot> {
    const signalsBySymbol = this.buildSignalSnapshot();
    const tradeState = this.webhookStateService.getTradeSnapshot();
    const paperTradesBySymbol = this.filterTradesBySymbol(tradeState.tradesBySymbol);
    const liveTradesBySymbol = this.filterTradesBySymbol(tradeState.liveTradesBySymbol);
    const symbols = this.collectSymbols(signalsBySymbol, paperTradesBySymbol, liveTradesBySymbol);
    const ticks = await this.buildTickSnapshot();
    const snapshot: HistoryBtcSnapshot = {
      dateKey,
      capturedAt: capturedAt.toISOString(),
      symbols,
      signalsBySymbol,
      paperTradesBySymbol,
      liveTradesBySymbol,
      ticks
    };
    this.saveSnapshot(snapshot);
    return snapshot;
  }

  private saveSnapshot(snapshot: HistoryBtcSnapshot): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(snapshot));
    } catch {
      // ignore storage failures
    }
  }

  private buildSignalSnapshot(): Record<string, SignalRow[]> {
    const result: Record<string, SignalRow[]> = {};
    const modes = ['btc-long', 'btc-short', 'btc'] as const;
    for (const mode of modes) {
      const state = this.webhookStateService.getSignalSnapshot(mode);
      for (const [symbol, rows] of state.bySymbol.entries()) {
        if (!this.isBtcSymbol(symbol)) {
          continue;
        }
        const existing = result[symbol] ?? [];
        result[symbol] = [...rows, ...existing];
      }
    }
    return result;
  }

  private filterTradesBySymbol(source: Map<string, TradeRow[]>): Record<string, TradeRow[]> {
    const result: Record<string, TradeRow[]> = {};
    for (const [symbol, rows] of source.entries()) {
      if (!this.isBtcSymbol(symbol)) {
        continue;
      }
      result[symbol] = rows;
    }
    return result;
  }

  private collectSymbols(
    signals: Record<string, SignalRow[]>,
    paper: Record<string, TradeRow[]>,
    live: Record<string, TradeRow[]>
  ): string[] {
    const set = new Set<string>();
    Object.keys(signals).forEach((symbol) => set.add(symbol));
    Object.keys(paper).forEach((symbol) => set.add(symbol));
    Object.keys(live).forEach((symbol) => set.add(symbol));
    return Array.from(set.values());
  }

  private async buildTickSnapshot(): Promise<TickRow[]> {
    const snapshot = this.tickFsmStateService.getSnapshot();
    const lotBySymbol = await this.fetchLotBySymbol();
    const rows: TickRow[] = [];
    for (const [symbol, data] of snapshot.entries()) {
      if (!this.isBtcSymbol(symbol)) {
        continue;
      }
      rows.push({
        symbol,
        ltp: data.ltp ?? null,
        threshold: data.threshold ?? null,
        quantity: this.computeQuantity(symbol, data.ltp ?? null, lotBySymbol),
        noSignal: data.state === 'NOSIGNAL',
        noPositionSignal: data.state === 'NOPOSITION_SIGNAL',
        buyPosition: data.state === 'BUYPOSITION' || data.state === 'SELLPOSITION',
        noPositionBlocked: data.state === 'NOPOSITION_BLOCKED'
      });
    }
    return rows;
  }

  private async fetchLotBySymbol(): Promise<Map<string, number>> {
    try {
      const response = await fetch('/instruments.json', { cache: 'no-store' });
      if (!response.ok) {
        return new Map<string, number>();
      }
      const parsed = await response.json();
      const meta = Array.isArray(parsed) ? (parsed as InstrumentMeta[]) : [];
      const map = new Map<string, number>();
      for (const instrument of meta) {
        if (typeof instrument.lot !== 'number') {
          continue;
        }
        if (typeof instrument.zerodha === 'string') {
          map.set(instrument.zerodha, instrument.lot);
        }
        if (typeof instrument.tradingview === 'string') {
          map.set(instrument.tradingview, instrument.lot);
        }
      }
      return map;
    } catch {
      return new Map<string, number>();
    }
  }

  private computeQuantity(
    symbol: string,
    ltp: number | null,
    lotBySymbol: Map<string, number>
  ): number | null {
    if (ltp === null) {
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

  private isBtcSymbol(symbol: string): boolean {
    return symbol.toUpperCase().startsWith('BTC');
  }
}
