import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { RelayAttempt, RelayService } from './relay.service';

@Component({
  selector: 'app-relay',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './relay.component.html',
  styleUrl: './relay.component.css'
})
export class RelayComponent {
  private readonly relayService = inject(RelayService);

  get ipAddress(): string {
    return this.relayService.ipAddress;
  }

  set ipAddress(value: string) {
    this.relayService.ipAddress = value;
  }

  get port(): string {
    return this.relayService.port;
  }

  set port(value: string) {
    this.relayService.port = value;
  }

  get capital(): string {
    return this.relayService.capital;
  }

  set capital(value: string) {
    this.relayService.capital = value;
  }

  get enabled(): boolean {
    return this.relayService.enabled;
  }

  set enabled(value: boolean) {
    this.relayService.enabled = value;
  }

  get attempts(): RelayAttempt[] {
    return this.relayService.attempts;
  }

  saveSettings(): void {
    this.relayService.saveSettings();
  }

  relayNow(): void {
    this.relayService.relayNow();
  }

  currentUrl(): string {
    return this.relayService.currentUrl();
  }
}
