import { CommonModule } from '@angular/common';
import { Component, Input, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatToolbarModule } from '@angular/material/toolbar';
import { BehaviorSubject, combineLatest, map, switchMap, tap } from 'rxjs';
import { FilterMode, WebhookStateService } from './webhook-state.service';

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

type BtcLiveRow = TradeRow & {
  openTime: string;
  closeTime: string;
};

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
  private readonly webhookStateService = inject(WebhookStateService);
  private currentMode: FilterMode = 'none';
  private readonly filterMode$ = new BehaviorSubject<FilterMode>('none');
  private loggedOnce = false;
  private lastActiveSymbol: string | null = null;
  @Input() set filterMode(value: FilterMode) {
    const mode = value ?? 'none';
    this.currentMode = mode;
    this.filterMode$.next(mode);
    console.log(`[webhook] mode set=${mode}`);
  }

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
  readonly shortLiveColumns = [
    'openTime',
    'openPrice',
    'closeTime',
    'closePrice',
    'unrealizedPnl',
    'cumulativePnl'
  ];
  readonly liveTradeColumns = [
    'sNo',
    'timeIst',
    'symbol',
    'entryPrice',
    'currentPrice',
    'unrealizedPnl',
    'cumulativePnl',
    'quantity'
  ];
  readonly liveShortColumns = [
    'sNo',
    'openTime',
    'openPrice',
    'closeTime',
    'closePrice',
    'unrealizedPnl',
    'cumulativePnl'
  ];

  private readonly signalState$ = this.filterMode$.pipe(
    switchMap((mode) => this.webhookStateService.signalState$(mode))
  );
  private readonly tradeState$ = this.webhookStateService.getTradeState$();

  readonly viewModel$ = combineLatest([this.signalState$, this.tradeState$]).pipe(
    map(([signalState, tradeState]) => {
      const state = signalState;
      if (
        (!this.selectedSymbol && state.symbols.length > 0)
        || (this.selectedSymbol && !state.symbols.includes(this.selectedSymbol))
      ) {
        this.selectedSymbol = state.symbols[0] ?? '';
      }
      const activeSymbol = this.selectedSymbol;
      const rows = activeSymbol ? state.bySymbol.get(activeSymbol) ?? [] : [];
      const paperRows: TradeRow[] = activeSymbol ? tradeState.tradesBySymbol.get(activeSymbol) ?? [] : [];
      const paperRowsBtc: BtcLiveRow[] = activeSymbol ? this.buildBtcPaperRows(tradeState, activeSymbol) : [];
      const liveRows: TradeRow[] = activeSymbol ? tradeState.liveTradesBySymbol.get(activeSymbol) ?? [] : [];
      const liveRowsBtc: BtcLiveRow[] = activeSymbol ? this.buildBtcLiveRows(tradeState, activeSymbol) : [];
      const paperBlockedUntilText = activeSymbol
        ? this.getPaperBlockedUntilText(tradeState, activeSymbol)
        : null;
      const blockedUntil = activeSymbol
        ? this.webhookStateService.getLiveTradeBlockedUntil(activeSymbol)
        : null;
      const blockedUntilText = blockedUntil && blockedUntil > Date.now()
        ? this.formatIstHm(new Date(blockedUntil))
        : null;
      return {
        symbols: state.symbols,
        activeSymbol,
        rows,
        paperRows,
        paperRowsBtc,
        liveRows,
        liveRowsBtc,
        paperBlockedUntilText,
        blockedUntilText,
        isBtcMode: this.isBtcMode(),
        isBtcShort: this.isBtcShortMode(),
        isTradeCompactMode: this.isTradeCompactMode(),
        isSignalCompactMode: this.isSignalCompactMode()
      };
    }),
    tap((vm) => {
      if (this.loggedOnce) {
        if (vm.activeSymbol !== this.lastActiveSymbol) {
          this.lastActiveSymbol = vm.activeSymbol;
          console.log(
            `[webhook] active symbol changed mode=${this.currentMode} symbol=${vm.activeSymbol ?? '--'} rows=${vm.rows.length}`
          );
        }
        return;
      }
      this.loggedOnce = true;
      this.lastActiveSymbol = vm.activeSymbol ?? null;
      console.log(
        `[webhook] view model symbols=${vm.symbols.length} active=${vm.activeSymbol ?? '--'} rows=${vm.rows.length} paper=${vm.paperRows.length} live=${vm.liveRows.length}`
      );
    })
  );

  clearSignals(): void {
    this.selectedSymbol = '';
    this.webhookStateService.clearSignals(this.currentMode);
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


  private isOpenTrade(row: TradeRow | BtcLiveRow): boolean {
    if ('closeTime' in row) {
      return !row.closeTime || row.closeTime === '--';
    }
    if (typeof row.id === 'string') {
      return !row.id.endsWith('-exit');
    }
    return true;
  }

  isBtcMode(): boolean {
    return this.currentMode === 'btc' || this.currentMode === 'btc-long' || this.currentMode === 'btc-short';
  }

  isBtcShortMode(): boolean {
    return this.currentMode === 'btc-short';
  }

  isTradeCompactMode(): boolean {
    return this.isBtcMode() || this.currentMode === 'zerodha6';
  }

  isSignalCompactMode(): boolean {
    return this.isBtcMode();
  }

  private buildBtcLiveRows(
    tradeState: {
      liveTradesBySymbol: Map<string, TradeRow[]>;
    },
    activeSymbol: string
  ): BtcLiveRow[] {
    const liveRows = tradeState.liveTradesBySymbol.get(activeSymbol) ?? [];
    const byId = new Map(liveRows.map((row) => [row.id, row]));
    return liveRows.map((row) => {
      const isExit = row.id.endsWith('-exit');
      const baseId = isExit ? row.id.replace(/-exit$/, '') : row.id;
      const openRow = byId.get(baseId);
      return {
        ...row,
        openTime: this.extractTime(openRow?.timeIst ?? (isExit ? '--' : row.timeIst)),
        openPrice: openRow?.entryPrice ?? row.entryPrice,
        closeTime: isExit ? this.extractTime(row.timeIst) : '--',
        closePrice: isExit ? row.currentPrice : null,
        unrealizedPnl: row.unrealizedPnl,
        cumulativePnl: row.cumulativePnl
      };
    });
  }

  private buildBtcPaperRows(
    tradeState: {
      tradesBySymbol: Map<string, TradeRow[]>;
    },
    activeSymbol: string
  ): BtcLiveRow[] {
    const rows = tradeState.tradesBySymbol.get(activeSymbol) ?? [];
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
        closePrice: isExit ? row.currentPrice : null,
        unrealizedPnl: row.unrealizedPnl,
        cumulativePnl: row.cumulativePnl
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

  private getPaperBlockedUntilText(
    tradeState: { lastSnapshotBySymbol: Map<string, { state: string; lastBlockedAtMs: number | null }> },
    symbol: string
  ): string | null {
    const snap = tradeState.lastSnapshotBySymbol.get(symbol);
    if (!snap || snap.state !== 'NOPOSITION_BLOCKED' || snap.lastBlockedAtMs === null) {
      return null;
    }
    const blockedUntil = new Date(snap.lastBlockedAtMs);
    blockedUntil.setSeconds(0, 0);
    blockedUntil.setMinutes(blockedUntil.getMinutes() + 1);
    return this.formatIstHm(blockedUntil);
  }

  private formatIstHm(value: Date): string {
    return value.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}
