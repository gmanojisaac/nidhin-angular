import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HistoryBtcService } from '../history-btc/history-btc.service';
import { TickFsmStateService } from '../tick/tick-fsm-state.service';
import { TickService } from '../tick/tick.service';
import { WebhookStateService } from '../webhook/webhook-state.service';

@Component({
  selector: 'app-main-page',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './main-page.component.html',
  styleUrl: './main-page.component.css'
})
export class MainPageComponent {
  private readonly tickService = inject(TickService);
  private readonly tickFsmStateService = inject(TickFsmStateService);
  private readonly webhookStateService = inject(WebhookStateService);
  private readonly historyBtcService = inject(HistoryBtcService);

  resetAll(): void {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem('tick-cache-latest');
        localStorage.removeItem('webhook-state-snapshot-v1');
        localStorage.removeItem('history-btc-latest');
        localStorage.removeItem('history-btc-last-reset');
        localStorage.removeItem('tick-fsm-snapshot-v1');
      } catch {
        // ignore storage failures
      }
    }
    this.tickService.clearCache();
    this.webhookStateService.resetBtcState();
    this.tickFsmStateService.clearAll();
    void this.historyBtcService;
  }
}
