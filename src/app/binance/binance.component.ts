import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatToolbarModule } from '@angular/material/toolbar';
import { BinanceService } from './binance.service';

@Component({
  selector: 'app-binance',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatChipsModule, MatToolbarModule],
  templateUrl: './binance.component.html',
  styleUrl: './binance.component.css'
})
export class BinanceComponent {
  private readonly binanceService = inject(BinanceService);
  readonly latestBinance$ = this.binanceService.binance$;

  formatPrice(value: number | undefined): string {
    if (value === undefined || Number.isNaN(value)) {
      return '--';
    }
    return value.toFixed(2);
  }

  formatTimestamp(value: number | string | undefined): string {
    if (value === undefined || value === null || Number.isNaN(value)) {
      return '--';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString();
  }

  formatJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}
