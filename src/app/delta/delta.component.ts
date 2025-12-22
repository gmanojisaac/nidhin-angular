import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatToolbarModule } from '@angular/material/toolbar';
import { DeltaService } from './delta.service';

@Component({
  selector: 'app-delta',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatChipsModule, MatToolbarModule],
  templateUrl: './delta.component.html',
  styleUrl: './delta.component.css'
})
export class DeltaComponent {
  private readonly deltaService = inject(DeltaService);
  readonly latestDelta$ = this.deltaService.delta$;

  formatPrice(value: number | undefined): string {
    if (value === undefined || Number.isNaN(value)) {
      return '--';
    }
    return value.toFixed(2);
  }

  formatTimestamp(value: number | string | undefined): string {
    if (value === undefined || value === null || Number.isNaN(value)) {
      return '--';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString();
  }

  formatJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}
