import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TickComponent } from '../tick/tick.component';
import { WebhookComponent } from '../webhook/webhook.component';

@Component({
  selector: 'app-current-app',
  standalone: true,
  imports: [RouterLink, TickComponent, WebhookComponent],
  templateUrl: './current-app.component.html',
  styleUrl: './current-app.component.css'
})
export class CurrentAppComponent {}
