import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { WebhookPayload, WebhookService } from '../webhook/webhook.service';

export type RelayAttempt = {
  time: string;
  url: string;
  status: 'success' | 'error';
  detail: string;
};

@Injectable({ providedIn: 'root' })
export class RelayService implements OnDestroy {
  private readonly webhookService = inject(WebhookService);
  private readonly subscription = new Subscription();

  ipAddress = this.loadSetting('relay.ip');
  port = this.loadSetting('relay.port', '3001');
  enabled = this.loadSetting('relay.enabled') === 'true';
  attempts: RelayAttempt[] = [];

  constructor() {
    this.subscription.add(
      this.webhookService.webhook$.subscribe((payload) => {
        if (!this.enabled) {
          return;
        }
        const url = this.buildRelayUrl();
        if (!url) {
          this.recordAttempt('error', 'Missing IP address', '--');
          return;
        }
        this.relayPayload(url, payload);
      })
    );
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  saveSettings(): void {
    this.persistSetting('relay.ip', this.ipAddress);
    this.persistSetting('relay.port', this.port);
    this.persistSetting('relay.enabled', String(this.enabled));
  }

  relayNow(): void {
    const url = this.buildRelayUrl();
    if (!url) {
      this.recordAttempt('error', 'Missing IP address', '--');
      return;
    }
    this.relayPayload(url, { symbol: 'TEST', intent: 'PING' });
  }

  currentUrl(): string {
    return this.buildRelayUrl() ?? '--';
  }

  private buildRelayUrl(): string | null {
    const ip = this.ipAddress.trim();
    if (!ip) {
      return null;
    }
    const port = this.port.trim() || '3001';
    if (ip.startsWith('http://') || ip.startsWith('https://')) {
      return `${ip.replace(/\/+$/, '')}/webhook`;
    }
    return `http://${ip}:${port}/webhook`;
  }

  private async relayPayload(url: string, payload: WebhookPayload): Promise<void> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        this.recordAttempt('error', `HTTP ${response.status}`, url);
        return;
      }
      this.recordAttempt('success', 'Delivered', url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      this.recordAttempt('error', message, url);
    }
  }

  private recordAttempt(status: RelayAttempt['status'], detail: string, url: string): void {
    const time = new Date().toLocaleTimeString();
    const next: RelayAttempt = { time, url, status, detail };
    this.attempts = [next, ...this.attempts].slice(0, 8);
  }

  private loadSetting(key: string, fallback = ''): string {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private persistSetting(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore storage errors
    }
  }
}
