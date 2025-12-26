import { Routes } from '@angular/router';
import { BinanceComponent } from './binance/binance.component';
import { CurrentAppComponent } from './current-app/current-app.component';
import { MainPageComponent } from './main-page/main-page.component';

export const routes: Routes = [
  { path: '', component: MainPageComponent },
  { path: 'app', component: CurrentAppComponent },
  { path: 'btc', component: BinanceComponent },
  { path: '**', redirectTo: '' }
];
