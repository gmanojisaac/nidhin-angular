import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { BinanceService } from '../binance/binance.service';
import { WebhookPayload, WebhookService } from '../webhook/webhook.service';
import { FsmSymbolSnapshot, TickFsmStateService } from './tick-fsm-state.service';

type FsmState = 'NOSIGNAL' | 'NOPOSITION_SIGNAL' | 'BUYPOSITION' | 'SELLPOSITION' | 'NOPOSITION_BLOCKED';

type InstrumentFsm = {
  state: FsmState;
  threshold: number | null;
  savedBUYThreshold: number | null;
  lastBUYThreshold: number | null;
  lastSELLThreshold: number | null;
  lastSignalAtMs: number | null;
  lastCheckedAtMs: number | null;
  lastBlockedAtMs: number | null;
};

@Injectable({ providedIn: 'root' })
export class BtcLongFsmService implements OnDestroy {
  private readonly webhookService = inject(WebhookService);
  private readonly binanceService = inject(BinanceService);
  private readonly fsmStateService = inject(TickFsmStateService);
  private readonly subs = new Subscription();
  private readonly symbolKey = 'BTCUSDT_LONG';
  private fsm = this.defaultFsm();
  private lastLtp: number | null = null;

  constructor() {
    const existing = this.fsmStateService.getSnapshot().get(this.symbolKey);
    if (existing) {
      this.fsm = {
        ...this.defaultFsm(),
        state: existing.state,
        threshold: existing.threshold,
        lastBUYThreshold: existing.lastBUYThreshold,
        lastSELLThreshold: existing.lastSELLThreshold
      };
      this.lastLtp = existing.ltp ?? null;
    }

    this.subs.add(
      this.webhookService.webhook$.subscribe((payload) => this.handleWebhook(payload))
    );

    this.subs.add(
      this.binanceService.binance$.subscribe((payload) => this.handleBinance(payload))
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  private handleWebhook(payload: WebhookPayload): void {
    if (!this.isBtcSymbol(payload.symbol)) {
      return;
    }
    const signal = this.getSignalType(payload);
    if (signal !== 'BUY') {
      return;
    }
    const next = this.applySignalTransition(this.fsm, signal, payload, this.lastLtp, Date.now());
    this.fsm = next;
    this.updateSnapshot();
  }

  private handleBinance(payload: { symbol?: string; price?: number | null }): void {
    if (!this.isBtcSymbol(payload.symbol)) {
      return;
    }
    const price = typeof payload.price === 'number' ? payload.price : null;
    if (price === null) {
      return;
    }
    this.lastLtp = price;
    this.fsmStateService.updateLastPrice(this.symbolKey, price);
    const result = this.applyTickTransition(this.fsm, price, Date.now());
    this.fsm = result.next;
    this.updateSnapshot();
  }

  private updateSnapshot(): void {
    const snapshot = new Map<string, FsmSymbolSnapshot>();
    snapshot.set(this.symbolKey, {
      state: this.fsm.state,
      ltp: this.lastLtp,
      threshold: this.fsm.threshold,
      lastBUYThreshold: this.fsm.lastBUYThreshold,
      lastSELLThreshold: this.fsm.lastSELLThreshold
    });
    this.fsmStateService.update(snapshot);
  }

  private isBtcSymbol(symbol: string | undefined): symbol is string {
    return typeof symbol === 'string' && symbol.toUpperCase() === 'BTCUSDT';
  }

  private getSignalType(payload: WebhookPayload): 'BUY' | 'SELL' | null {
    const intentCandidate = `${payload.intent ?? ''}`.toUpperCase();
    if (intentCandidate === 'BUY' || intentCandidate === 'ENTRY') {
      return 'BUY';
    }
    if (intentCandidate === 'SELL' || intentCandidate === 'EXIT') {
      return 'SELL';
    }
    const sideCandidate = `${payload.side ?? ''}`.toUpperCase();
    if (sideCandidate === 'BUY') {
      return 'BUY';
    }
    if (sideCandidate === 'SELL') {
      return 'SELL';
    }
    return null;
  }

  private applySignalTransition(
    current: InstrumentFsm,
    signal: 'BUY' | 'SELL',
    payload: WebhookPayload,
    latestLtp: number | null,
    receivedAt: number
  ): InstrumentFsm {
    if (signal === 'BUY') {
      const threshold = typeof payload.stoppx === 'number' ? payload.stoppx : null;
      return {
        state: 'NOPOSITION_SIGNAL',
        threshold,
        savedBUYThreshold: threshold,
        lastBUYThreshold: threshold,
        lastSELLThreshold: current.lastSELLThreshold,
        lastSignalAtMs: receivedAt,
        lastCheckedAtMs: null,
        lastBlockedAtMs: null
      };
    }
    const threshold = latestLtp;
    return {
      state: 'NOPOSITION_SIGNAL',
      threshold,
      savedBUYThreshold: current.savedBUYThreshold,
      lastBUYThreshold: current.lastBUYThreshold,
      lastSELLThreshold: threshold,
      lastSignalAtMs: receivedAt,
      lastCheckedAtMs: null,
      lastBlockedAtMs: null
    };
  }

  private applyTickTransition(
    current: InstrumentFsm,
    ltp: number | null,
    receivedAt: number
  ): { next: InstrumentFsm; intermediate?: InstrumentFsm } {
    if (current.threshold === null || current.lastSignalAtMs === null || ltp === null) {
      return { next: current };
    }
    if (current.state === 'BUYPOSITION') {
      if (ltp >= current.threshold) {
        return { next: current };
      }
      return {
        next: {
          ...current,
          state: 'NOPOSITION_BLOCKED',
          lastCheckedAtMs: receivedAt,
          lastBlockedAtMs: receivedAt
        }
      };
    }
    if (current.state === 'NOPOSITION_SIGNAL') {
      if (current.lastCheckedAtMs !== null && current.lastCheckedAtMs >= current.lastSignalAtMs) {
        return { next: current };
      }
      const nextState: FsmState = ltp > current.threshold ? 'BUYPOSITION' : 'NOPOSITION_BLOCKED';
      return {
        next: {
          ...current,
          state: nextState,
          lastCheckedAtMs: receivedAt,
          lastBlockedAtMs: nextState === 'NOPOSITION_BLOCKED' ? receivedAt : null
        }
      };
    }
    if (current.state === 'NOPOSITION_BLOCKED') {
      if (!this.isFirstSecondNextMinute(current.lastBlockedAtMs, receivedAt)) {
        return { next: current };
      }
      const intermediate: InstrumentFsm = {
        ...current,
        state: 'NOPOSITION_SIGNAL',
        lastSignalAtMs: receivedAt,
        lastCheckedAtMs: null,
        lastBlockedAtMs: null
      };
      const nextState: FsmState = ltp > current.threshold ? 'BUYPOSITION' : 'NOPOSITION_BLOCKED';
      const finalState: InstrumentFsm = {
        ...intermediate,
        state: nextState,
        lastCheckedAtMs: receivedAt,
        lastBlockedAtMs: nextState === 'NOPOSITION_BLOCKED' ? receivedAt : null
      };
      return { intermediate, next: finalState };
    }
    return { next: current };
  }

  private isFirstSecondNextMinute(anchorAtMs: number | null, tickAtMs: number): boolean {
    if (anchorAtMs === null) {
      return false;
    }
    const signalMinute = Math.floor(anchorAtMs / 60000);
    const tickMinute = Math.floor(tickAtMs / 60000);
    if (tickMinute <= signalMinute) {
      return false;
    }
    return new Date(tickAtMs).getSeconds() === 0;
  }

  private defaultFsm(): InstrumentFsm {
    return {
      state: 'NOSIGNAL',
      threshold: null,
      savedBUYThreshold: null,
      lastBUYThreshold: null,
      lastSELLThreshold: null,
      lastSignalAtMs: null,
      lastCheckedAtMs: null,
      lastBlockedAtMs: null
    };
  }
}
