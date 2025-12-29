import { CommonModule } from '@angular/common';
import { Component, Input, OnDestroy, OnInit, inject } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatToolbarModule } from '@angular/material/toolbar';
import { filter, Subscription } from 'rxjs';
import { DeltaComponent } from '../delta/delta.component';
import { DeltaRestComponent } from '../delta-rest/delta-rest.component';
import { TickComponent } from '../tick/tick.component';
import { WebhookComponent } from '../webhook/webhook.component';
import { BinanceService } from '../binance/binance.service';

@Component({
  selector: 'app-btc-long',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    MatCardModule,
    MatChipsModule,
    MatToolbarModule,
    DeltaComponent,
    DeltaRestComponent,
    TickComponent,
    WebhookComponent
  ],
  templateUrl: './btc-long.component.html',
  styleUrl: './btc-long.component.css'
})
export class BtcLongComponent implements OnInit, OnDestroy {
  private readonly binanceService = inject(BinanceService);
  private readonly router = inject(Router);
  private navSub: Subscription | null = null;
  readonly latestBinance$ = this.binanceService.binance$;
  @Input() showHeader = true;
  @Input() showBinanceCard = true;
  @Input() showDeltaPanels = true;

  ngOnInit(): void {
    console.log('[btc-long] component init');
    console.log(`[btc-long] enter url=${this.router.url}`);
    this.navSub = this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd)
    ).subscribe((event) => {
      const nav = event as NavigationEnd;
      console.log(`[nav] url=${nav.urlAfterRedirects}`);
    });
  }

  ngOnDestroy(): void {
    console.log('[btc-long] destroy');
    this.navSub?.unsubscribe();
    this.navSub = null;
  }

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
