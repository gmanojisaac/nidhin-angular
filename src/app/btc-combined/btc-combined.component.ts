import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BtcLongComponent } from '../btc-long/btc-long.component';
import { BtcShortComponent } from '../btc-short/btc-short.component';

@Component({
  selector: 'app-btc-combined',
  standalone: true,
  imports: [CommonModule, RouterLink, BtcLongComponent, BtcShortComponent],
  templateUrl: './btc-combined.component.html',
  styleUrl: './btc-combined.component.css'
})
export class BtcCombinedComponent {}
