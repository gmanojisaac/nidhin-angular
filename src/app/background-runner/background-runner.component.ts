import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { TickComponent } from '../tick/tick.component';

@Component({
  selector: 'app-background-runner',
  standalone: true,
  imports: [CommonModule, TickComponent],
  templateUrl: './background-runner.component.html',
  styleUrl: './background-runner.component.css'
})
export class BackgroundRunnerComponent {}
