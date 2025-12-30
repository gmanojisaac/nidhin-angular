import { Injectable, OnDestroy, inject } from '@angular/core';
import { HistoryBtcService } from './history-btc.service';
import { TickFsmStateService } from '../tick/tick-fsm-state.service';
import { TickService } from '../tick/tick.service';
import { WebhookStateService } from '../webhook/webhook-state.service';

@Injectable({ providedIn: 'root' })
export class HistoryBtcSchedulerService implements OnDestroy {
  private readonly historyService = inject(HistoryBtcService);
  private readonly webhookStateService = inject(WebhookStateService);
  private readonly tickService = inject(TickService);
  private readonly tickFsmStateService = inject(TickFsmStateService);
  private readonly resetKey = 'history-btc-last-reset';
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.maybeRunCatchUp();
    this.scheduleNextRun();
  }

  ngOnDestroy(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
    }
  }

  private maybeRunCatchUp(): void {
    const now = new Date();
    if (!this.isAfterIstTime(now, 5, 30)) {
      return;
    }
    const todayKey = this.getIstDateKey(now);
    if (this.getLastResetKey() === todayKey) {
      return;
    }
    void this.runSnapshotAndClear(now);
  }

  private scheduleNextRun(): void {
    const delay = this.getMsUntilNextIstTime(new Date(), 5, 30);
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      void this.runSnapshotAndClear(new Date()).finally(() => {
        this.scheduleNextRun();
      });
    }, delay);
  }

  private async runSnapshotAndClear(now: Date): Promise<void> {
    const snapshotDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const snapshotKey = this.getIstDateKey(snapshotDate);
    await this.historyService.captureSnapshot(snapshotKey, now);
    this.webhookStateService.resetBtcState();
    this.tickService.clearCache();
    this.tickFsmStateService.clearSymbols(['BTCUSDT', 'BTCUSDT_LONG', 'BTCUSDT_SHORT', 'BTCUSD']);
    this.setLastResetKey(this.getIstDateKey(now));
  }

  private getLastResetKey(): string {
    if (typeof localStorage === 'undefined') {
      return '';
    }
    try {
      return localStorage.getItem(this.resetKey) ?? '';
    } catch {
      return '';
    }
  }

  private setLastResetKey(value: string): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(this.resetKey, value);
    } catch {
      // ignore storage errors
    }
  }

  private getMsUntilNextIstTime(now: Date, hour: number, minute: number): number {
    const parts = this.getIstParts(now);
    let targetYear = parts.year;
    let targetMonth = parts.month;
    let targetDay = parts.day;
    const currentMinutes = parts.hour * 60 + parts.minute;
    const targetMinutes = hour * 60 + minute;
    if (currentMinutes >= targetMinutes) {
      const next = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay));
      next.setUTCDate(next.getUTCDate() + 1);
      targetYear = next.getUTCFullYear();
      targetMonth = next.getUTCMonth() + 1;
      targetDay = next.getUTCDate();
    }
    const targetUtcMs = Date.UTC(
      targetYear,
      targetMonth - 1,
      targetDay,
      hour - 5,
      minute - 30,
      0,
      0
    );
    const delay = targetUtcMs - now.getTime();
    return Math.max(1000, delay);
  }

  private isAfterIstTime(now: Date, hour: number, minute: number): boolean {
    const parts = this.getIstParts(now);
    const currentMinutes = parts.hour * 60 + parts.minute;
    return currentMinutes >= hour * 60 + minute;
  }

  private getIstDateKey(now: Date): string {
    const parts = this.getIstParts(now);
    const month = String(parts.month).padStart(2, '0');
    const day = String(parts.day).padStart(2, '0');
    return `${parts.year}-${month}-${day}`;
  }

  private getIstParts(now: Date): { year: number; month: number; day: number; hour: number; minute: number } {
    const parts = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour'),
      minute: get('minute')
    };
  }
}
