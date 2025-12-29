import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { BtcFsmService } from './tick/btc-fsm.service';
import { BtcLongFsmService } from './tick/btc-long-fsm.service';
import { BtcShortFsmService } from './tick/btc-short-fsm.service';
import { RelayService } from './relay/relay.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  private readonly btcFsmService = inject(BtcFsmService);
  private readonly btcLongFsmService = inject(BtcLongFsmService);
  private readonly btcShortFsmService = inject(BtcShortFsmService);
  private readonly relayService = inject(RelayService);

  constructor() {
    void this.btcFsmService;
    void this.btcLongFsmService;
    void this.btcShortFsmService;
    void this.relayService;
  }
}
