# Test Cases

## FSM Long (BTCUSDT_LONG)
1) Send BUY/ENTRY with stoppx = 100.
2) Tick LTP = 101 -> expect BUYPOSITION.
3) Tick LTP = 99 -> expect NOPOSITION_BLOCKED.

## FSM Short (BTCUSDT_SHORT)
1) Send SELL/EXIT with stoppx = 100 (threshold uses latest LTP).
2) Tick LTP = 99 -> expect SELLPOSITION.
3) Tick LTP = 101 -> expect NOPOSITION_BLOCKED.

## Paper Trade Entry/Exit
1) Force FSM enter BUYPOSITION/SELLPOSITION -> paper entry row created.
2) Force FSM leave position -> paper exit row created.

## Live Trade Entry Rule
1) Set cumulative PnL = 0 -> live entry allowed.
2) Set cumulative PnL < 0 -> live entry blocked.

## Live Trade Exit Rule
1) With open live trade, set (paper unrealized + cumulative) < 0 -> live exit created.
2) Ensure live re-entry blocked until next minute boundary.

## UI Checks
1) BTC Live Trades table shows Open/Close time+price columns.
2) Zerodha6 signals table shows alternate signal columns.
3) Symbol dropdown affects signals, paper trades, and live trades.

