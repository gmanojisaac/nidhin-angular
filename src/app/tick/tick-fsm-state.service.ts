import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type FsmSymbolSnapshot = {
  state: 'NOSIGNAL' | 'NOPOSITION_SIGNAL' | 'BUYPOSITION' | 'SELLPOSITION' | 'NOPOSITION_BLOCKED';
  ltp: number | null;
  threshold: number | null;
  lastBUYThreshold: number | null;
  lastSELLThreshold: number | null;
  lastBlockedAtMs: number | null;
};

@Injectable({ providedIn: 'root' })
export class TickFsmStateService {
  private readonly subject = new BehaviorSubject<Map<string, FsmSymbolSnapshot>>(new Map());
  readonly fsmBySymbol$ = this.subject.asObservable();
  private readonly lastPriceBySymbol = new Map<string, number>();
  private readonly lastThresholdBySymbol = new Map<string, number>();
  private readonly lastLogAtBySymbol = new Map<string, number>();

  update(snapshot: Map<string, FsmSymbolSnapshot>): void {
    if (snapshot.size === 0) {
      return;
    }
    const next = new Map(this.subject.value);
    for (const [symbol, data] of snapshot.entries()) {
      const prev = next.get(symbol);
      if (prev && this.shouldLogUpdate(symbol, prev, data)) {
        this.lastLogAtBySymbol.set(symbol, Date.now());
        console.log(
          `[fsm-state] update symbol=${symbol} state=${data.state} threshold=${data.threshold ?? '--'}`
        );
      }
      next.set(symbol, data);
      if (data.threshold !== null) {
        this.lastThresholdBySymbol.set(symbol, data.threshold);
      }
    }
    this.subject.next(next);
  }

  getLastPrice(symbol: string): number | null {
    return this.lastPriceBySymbol.get(symbol) ?? null;
  }

  updateLastPrice(symbol: string, price: number): void {
    this.lastPriceBySymbol.set(symbol, price);
  }

  getLastThreshold(symbol: string): number | null {
    return this.lastThresholdBySymbol.get(symbol) ?? null;
  }

  getSnapshot(): Map<string, FsmSymbolSnapshot> {
    return this.subject.value;
  }

  clearSymbols(symbols: string[]): void {
    if (symbols.length === 0) {
      return;
    }
    const next = new Map(this.subject.value);
    for (const symbol of symbols) {
      next.delete(symbol);
      this.lastPriceBySymbol.delete(symbol);
      this.lastThresholdBySymbol.delete(symbol);
      this.lastLogAtBySymbol.delete(symbol);
    }
    this.subject.next(next);
  }

  private shouldLogUpdate(
    symbol: string,
    prev: FsmSymbolSnapshot,
    next: FsmSymbolSnapshot
  ): boolean {
    const changed = (
      prev.state !== next.state
      || prev.threshold !== next.threshold
      || prev.lastBUYThreshold !== next.lastBUYThreshold
      || prev.lastSELLThreshold !== next.lastSELLThreshold
      || prev.lastBlockedAtMs !== next.lastBlockedAtMs
    );
    if (!changed) {
      return false;
    }
    if (prev.state !== next.state || prev.threshold !== next.threshold) {
      return true;
    }
    const lastLogAt = this.lastLogAtBySymbol.get(symbol) ?? 0;
    return Date.now() - lastLogAt > 1500;
  }
}
