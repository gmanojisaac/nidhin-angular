import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TickFsmStateService } from '../tick/tick-fsm-state.service';
import { WebhookPayload, WebhookService } from './webhook.service';
import { WebhookStateService } from './webhook-state.service';

describe('WebhookStateService', () => {
  let webhookSubject: Subject<WebhookPayload>;

  beforeEach(() => {
    webhookSubject = new Subject<WebhookPayload>();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { tradingview: 'BTCUSDT', zerodha: 'BTCUSD', token: 99999999, lot: 1 }
      ]
    }));

    TestBed.configureTestingModule({
      providers: [
        WebhookStateService,
        { provide: WebhookService, useValue: { webhook$: webhookSubject } },
        { provide: TickFsmStateService, useValue: { fsmBySymbol$: new BehaviorSubject(new Map()) } }
      ]
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retains BTC state across subscribers', async () => {
    const service = TestBed.inject(WebhookStateService);

    let latest: any = null;

    const sub = service.signalState$('btc').subscribe((state) => {
      latest = state;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(latest?.symbols.length ?? 0).toBe(0);

    webhookSubject.next({ symbol: 'BTCUSDT', stoppx: 100, intent: 'BUY' });
    expect(latest?.symbols).toEqual(['BTCUSDT']);
    expect(latest?.bySymbol.get('BTCUSDT')?.length ?? 0).toBe(1);

    sub.unsubscribe();

    let second: any = null;
    const sub2 = service.signalState$('btc').subscribe((state) => {
      second = state;
    });

    expect(second?.symbols).toEqual(['BTCUSDT']);
    expect(second?.bySymbol.get('BTCUSDT')?.length ?? 0).toBe(1);

    sub2.unsubscribe();
  });
});
