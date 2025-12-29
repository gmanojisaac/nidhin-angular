# FSM Specs

## Common
- Signal sets threshold:
  - BUY/ENTRY: threshold = stoppx
  - SELL/EXIT: threshold = latest LTP
- If threshold or lastSignalAtMs is missing, no tick transition occurs.
- After NOPOSITION_BLOCKED, re-check only at first second of next minute.

## Long (BTCUSDT_LONG)
- NOPOSITION_SIGNAL:
  - LTP > threshold -> BUYPOSITION
  - else -> NOPOSITION_BLOCKED
- BUYPOSITION:
  - LTP >= threshold -> stay BUYPOSITION
  - else -> NOPOSITION_BLOCKED

## Short (BTCUSDT_SHORT)
- NOPOSITION_SIGNAL:
  - LTP < threshold -> SELLPOSITION
  - else -> NOPOSITION_BLOCKED
- SELLPOSITION:
  - LTP <= threshold -> stay SELLPOSITION
  - else -> NOPOSITION_BLOCKED

