# Trade Rules

## Paper Trades
- Enter when FSM transitions into a position state:
  - BUYPOSITION or SELLPOSITION
- Exit when FSM leaves a position state.

## Live Trades
- Enter only when paper trade is open AND:
  - cumulative PnL == 0, OR
  - (paper unrealized + cumulative) > 0
- Exit immediately when:
  - (paper unrealized + cumulative) < 0
- After live exit, block new live entries until next minute boundary.

## Tables
- Paper trades: full history (entry + exit rows).
- Live trades: open live row + all exit rows from live history.

