# ESP32 Control Protocol v1

Transport: newline-delimited UTF-8 JSON from Raspberry Pi to ESP32 over USB serial or UART.

Example packet:

```json
{"seq":1234,"throttle":0.25,"steering":-0.1,"brake":false,"mode":"normal","ts":123456789}
```

Fields:

- `seq`: monotonically increasing server-side integer.
- `throttle`: normalized float in `[-1.0, 1.0]`. Positive is forward.
- `steering`: normalized float in `[-1.0, 1.0]`. Negative is left, positive is right.
- `brake`: boolean emergency stop flag. When true, ESP32 must stop motor output.
- `mode`: `"normal"` or `"estop"`.
- `ts`: server Unix timestamp in milliseconds.

Safety TODO for ESP32 firmware:

- If no valid packet is received for 300 ms, stop throttle and center steering.
- If JSON parsing fails, ignore the packet and keep the last valid command until the 300 ms failsafe expires.
- Clamp all decoded values again on the ESP32 before mapping to PWM.
- Treat `brake=true` or `mode="estop"` as immediate motor stop and centered steering.

