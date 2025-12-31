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
  private readonly persistKey = 'tick-fsm-snapshot-v1';
  private persistTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly unloadHandler = () => this.saveSnapshot();
  private readonly lastPriceBySymbol = new Map<string, number>();
  private readonly lastThresholdBySymbol = new Map<string, number>();
  private readonly lastLogAtBySymbol = new Map<string, number>();

  constructor() {
    this.hydrateFromStorage();
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.unloadHandler);
    }
  }

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
    this.schedulePersist();
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
    this.schedulePersist();
  }

  clearAll(): void {
    this.subject.next(new Map());
    this.lastPriceBySymbol.clear();
    this.lastThresholdBySymbol.clear();
    this.lastLogAtBySymbol.clear();
    this.schedulePersist();
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

  private hydrateFromStorage(): void {
    const snapshot = this.loadSnapshot();
    if (!snapshot) {
      return;
    }
    this.subject.next(new Map(snapshot));
    for (const [symbol, data] of snapshot) {
      if (data.threshold !== null) {
        this.lastThresholdBySymbol.set(symbol, data.threshold);
      }
      if (typeof data.ltp === 'number') {
        this.lastPriceBySymbol.set(symbol, data.ltp);
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimeout !== null) {
      return;
    }
    this.persistTimeout = setTimeout(() => {
      this.persistTimeout = null;
      this.saveSnapshot();
    }, 1000);
  }

  private saveSnapshot(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    const entries = Array.from(this.subject.value.entries());
    try {
      localStorage.setItem(this.persistKey, JSON.stringify(entries));
    } catch {
      // ignore storage failures
    }
  }

  private loadSnapshot(): [string, FsmSymbolSnapshot][] | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    try {
      const raw = localStorage.getItem(this.persistKey);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as [string, FsmSymbolSnapshot][]) : null;
    } catch {
      return null;
    }
  }
}
