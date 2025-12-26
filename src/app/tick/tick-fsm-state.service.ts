import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type FsmSymbolSnapshot = {
  state: 'NOSIGNAL' | 'NOPOSITION_SIGNAL' | 'BUYPOSITION' | 'NOPOSITION_BLOCKED';
  ltp: number | null;
  threshold: number | null;
  lastBUYThreshold: number | null;
  lastSELLThreshold: number | null;
};

@Injectable({ providedIn: 'root' })
export class TickFsmStateService {
  private readonly subject = new BehaviorSubject<Map<string, FsmSymbolSnapshot>>(new Map());
  readonly fsmBySymbol$ = this.subject.asObservable();

  update(snapshot: Map<string, FsmSymbolSnapshot>): void {
    this.subject.next(snapshot);
  }

  getSnapshot(): Map<string, FsmSymbolSnapshot> {
    return this.subject.value;
  }
}
