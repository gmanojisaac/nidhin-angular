import { Component } from '@angular/core';
import { TickComponent } from './tick/tick.component';
import { WebhookComponent } from './webhook/webhook.component';
import { BinanceComponent } from './binance/binance.component';
import { DeltaComponent } from './delta/delta.component';
import { DeltaRestComponent } from './delta-rest/delta-rest.component';

@Component({
  selector: 'app-root',
  imports: [TickComponent, WebhookComponent, BinanceComponent, DeltaComponent, DeltaRestComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
}
