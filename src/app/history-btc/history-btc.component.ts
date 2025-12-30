import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HistoryBtcService, HistoryBtcSnapshot } from './history-btc.service';

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

type SignalRow = {
  timeIst: string;
  intent: string | null;
  stoppx: number | null;
  alternateSignal: boolean;
  buySellSell: boolean;
  sellBuyBuy: boolean;
};

type BtcLiveRow = TradeRow & {
  openTime: string;
  closeTime: string;
  closePrice: number | null;
  openPrice: number | null;
};

@Component({
  selector: 'app-history-btc',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './history-btc.component.html',
  styleUrl: './history-btc.component.css'
})
export class HistoryBtcComponent implements OnInit {
  private readonly historyService = inject(HistoryBtcService);

  snapshot: HistoryBtcSnapshot | null = null;
  selectedSymbol = '';

  ngOnInit(): void {
    this.snapshot = this.historyService.getLatestSnapshot();
    if (this.snapshot?.symbols.length) {
      this.selectedSymbol = this.snapshot.symbols[0];
    }
  }

  get symbols(): string[] {
    return this.snapshot?.symbols ?? [];
  }

  get signals(): SignalRow[] {
    if (!this.snapshot || !this.selectedSymbol) {
      return [];
    }
    return this.snapshot.signalsBySymbol[this.selectedSymbol] ?? [];
  }

  get paperRowsBtc(): BtcLiveRow[] {
    const rows = this.getTradeRows(this.snapshot?.paperTradesBySymbol);
    return this.buildBtcRows(rows);
  }

  get liveRowsBtc(): BtcLiveRow[] {
    const rows = this.getTradeRows(this.snapshot?.liveTradesBySymbol);
    return this.buildBtcRows(rows);
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

  formatLiveUnrealized(row: TradeRow | BtcLiveRow): string {
    const base = row.unrealizedPnl ?? null;
    if (base === null || Number.isNaN(base)) {
      return '--';
    }
    const adjusted = this.isOpenTrade(row) ? base - 50 : base;
    return adjusted.toFixed(2);
  }

  private getTradeRows(source?: Record<string, TradeRow[]>): TradeRow[] {
    if (!source || !this.selectedSymbol) {
      return [];
    }
    return source[this.selectedSymbol] ?? [];
  }

  private buildBtcRows(rows: TradeRow[]): BtcLiveRow[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return rows.map((row) => {
      const isExit = row.id.endsWith('-exit');
      const baseId = isExit ? row.id.replace(/-exit$/, '') : row.id;
      const openRow = byId.get(baseId);
      return {
        ...row,
        openTime: this.extractTime(openRow?.timeIst ?? (isExit ? '--' : row.timeIst)),
        openPrice: openRow?.entryPrice ?? row.entryPrice,
        closeTime: isExit ? this.extractTime(row.timeIst) : '--',
        closePrice: isExit ? row.currentPrice : null
      };
    });
  }

  private extractTime(value: string): string {
    if (!value || value === '--') {
      return '--';
    }
    const parts = value.trim().split(' ');
    return parts[1] ?? value;
  }

  private isOpenTrade(row: TradeRow | BtcLiveRow): boolean {
    if ('closeTime' in row) {
      return !row.closeTime || row.closeTime === '--';
    }
    if (typeof row.id === 'string') {
      return !row.id.endsWith('-exit');
    }
    return true;
  }
}
