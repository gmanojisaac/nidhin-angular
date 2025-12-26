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
  @Input() set filterMode(value: FilterMode) {
    const mode = value ?? 'none';
    this.currentMode = mode;
    this.filterMode$.next(mode);
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
      const paperRows = activeSymbol ? tradeState.tradesBySymbol.get(activeSymbol) ?? [] : [];
      const liveRows = activeSymbol ? state.liveTradesBySymbol.get(activeSymbol) ?? [] : [];
      return {
        symbols: state.symbols,
        activeSymbol,
        rows,
        paperRows,
        liveRows
      };
    }),
    tap((vm) => {
      if (this.loggedOnce) {
        return;
      }
      this.loggedOnce = true;
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
}
