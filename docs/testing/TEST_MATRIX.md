# Test Matrix

## FSM Transitions
- Long: BUY signal -> NOPOSITION_SIGNAL -> BUYPOSITION on LTP > threshold.
- Long: BUYPOSITION -> NOPOSITION_BLOCKED on LTP < threshold.
- Short: SELL signal -> NOPOSITION_SIGNAL -> SELLPOSITION on LTP < threshold.
- Short: SELLPOSITION -> NOPOSITION_BLOCKED on LTP > threshold.
- Blocked -> re-check at next minute boundary only.

## Paper Trades
- Enter on FSM entering position.
- Exit on FSM leaving position.

## Live Trades
- Enter allowed when cumulative == 0.
- Enter allowed when cumulative > 0 with unrealized >= 0.
- Deny entry when cumulative < 0.
- Forced exit when (unrealized + cumulative) < 0.
- Block live entry until next minute boundary.

## UI Mapping
- BTC pages use compact live/paper columns.
- Zerodha6 signals show full columns.
- Symbol dropdown drives all three sections.

