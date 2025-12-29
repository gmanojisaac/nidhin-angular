import { Routes } from '@angular/router';
import { BinanceComponent } from './binance/binance.component';
import { BtcCombinedComponent } from './btc-combined/btc-combined.component';
import { BtcLongComponent } from './btc-long/btc-long.component';
import { BtcShortComponent } from './btc-short/btc-short.component';
import { CurrentAppComponent } from './current-app/current-app.component';
import { MainPageComponent } from './main-page/main-page.component';
import { RelayComponent } from './relay/relay.component';

export const routes: Routes = [
  { path: '', component: MainPageComponent },
  { path: 'app', component: CurrentAppComponent },
  { path: 'btc', component: BinanceComponent },
  { path: 'btc-long', component: BtcLongComponent },
  { path: 'btc-short', component: BtcShortComponent },
  { path: 'btc-combined', component: BtcCombinedComponent },
  { path: 'relay', component: RelayComponent },
  { path: '**', redirectTo: '' }
];
