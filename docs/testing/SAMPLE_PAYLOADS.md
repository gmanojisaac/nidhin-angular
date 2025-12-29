# Sample Payloads

## Webhook Payloads

### Long Entry (BUY)
```json
{
  "symbol": "BTCUSDT",
  "intent": "ENTRY",
  "side": "BUY",
  "stoppx": 87856
}
```

### Long Exit (SELL)
```json
{
  "symbol": "BTCUSDT",
  "intent": "EXIT",
  "side": "SELL",
  "stoppx": 87856
}
```

### Short Entry (SELL)
```json
{
  "symbol": "BTCUSDT",
  "intent": "EXIT",
  "side": "SELL",
  "stoppx": 87910
}
```

### Short Exit (BUY)
```json
{
  "symbol": "BTCUSDT",
  "intent": "ENTRY",
  "side": "BUY",
  "stoppx": 87910
}
```

## Tick Payloads

### Binance Tick
```json
{
  "symbol": "BTCUSDT",
  "price": 87920.5,
  "timestamp": 1735384500000
}
```

### Zerodha Tick
```json
{
  "instrument_token": 123456,
  "last_price": 197.5
}
```

