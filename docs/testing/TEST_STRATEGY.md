# Testing Strategy

## Scope
- BTC long/short FSM state transitions.
- Zerodha6 FSM state transitions.
- Paper trade entry/exit rules.
- Live trade entry/exit/block rules.
- UI table mappings for BTC and Zerodha6 pages.

## Out of Scope
- Backend socket reliability.
- External webhook delivery.
- Network retries beyond basic fetch failures.

## Acceptance Criteria
- FSM transitions match the documented rules for long/short.
- Paper trades only enter/exit on FSM state changes.
- Live trades follow cumulative PnL rule and minute block rule.
- BTC pages show compact live/paper columns; Zerodha6 signals show full columns.

## Test Types
- Unit tests for FSM services and trade rules.
- Component tests for UI table rendering.
- Integration tests with simulated ticks and webhooks.

