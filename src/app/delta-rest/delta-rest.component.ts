import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatToolbarModule } from '@angular/material/toolbar';
import { DeltaRestService } from './delta-rest.service';

@Component({
  selector: 'app-delta-rest',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatChipsModule, MatToolbarModule],
  templateUrl: './delta-rest.component.html',
  styleUrl: './delta-rest.component.css'
})
export class DeltaRestComponent {
  private readonly deltaRestService = inject(DeltaRestService);
  readonly latestDeltaRest$ = this.deltaRestService.deltaRest$;

  formatPrice(value: number | undefined): string {
    if (value === undefined || Number.isNaN(value)) {
      return '--';
    }
    return value.toFixed(2);
  }

  formatTimestamp(value: number | undefined): string {
    if (value === undefined || Number.isNaN(value)) {
      return '--';
    }
    return new Date(value).toLocaleTimeString();
  }

  formatJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}
