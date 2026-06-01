# ESP32 Arduino Receiver

Arduino-framework firmware for receiving Raspberry Pi control packets and driving a steering servo plus ESC or servo-style motor controller.

Default safety behavior:

- `SIMULATION_MODE` is enabled in `arduino_receiver.ino`, so PWM writes are disabled.
- `DEBUG_OUTPUT` is enabled, so diagnostics are printed on the same serial link.
- Failsafe stops throttle and centers steering if no valid packet arrives for 300 ms.
- `brake=true` or `mode:"estop"` immediately outputs neutral throttle and centered steering.
- Throttle and steering are clamped to `[-1.0, 1.0]`.

## Dependencies

Install the `ArduinoJson` library through Arduino IDE Library Manager or PlatformIO.

Board target: an ESP32 dev board using the Arduino framework.

The sketch supports Arduino-ESP32 core 2.x and 3.x LEDC APIs. Current Arduino IDE installs usually use 3.x.

## Wiring

Default pins:

- Steering servo signal: GPIO 18
- ESC or motor-driver PWM signal: GPIO 19
- Ground: common ground between ESP32, servo/ESC signal ground, and external power ground

Do not power a steering servo or drive motor from the ESP32 3.3 V pin. Use a proper external BEC or motor supply. Keep signal logic at 3.3 V compatible levels.

USB serial mode:

- Connect ESP32 to Raspberry Pi over USB.
- Set Pi backend `serial.port` to `/dev/ttyUSB0` or `/dev/ttyACM0`.

UART mode:

- Connect Pi TX to ESP32 RX, Pi RX to ESP32 TX, and GND to GND.
- Use 3.3 V logic only.
- Keep the configured baud rate at 115200 unless both sides are changed.

## First Upload

1. Keep `SIMULATION_MODE 1`.
2. Upload the sketch.
3. Open Serial Monitor at 115200 baud.
4. Send a test line:

```json
{"seq":1,"throttle":0.0,"steering":0.0,"brake":false,"mode":"normal","ts":123}
```

You should see debug output showing normalized values and calculated pulse widths.

## Enable PWM Outputs

After bench testing:

```cpp
#define SIMULATION_MODE 0
```

Then upload again. Keep wheels off the ground and disconnect motor power until steering direction and throttle neutral are confirmed.

## Steering Calibration

Edit these constants in `arduino_receiver.ino`:

```cpp
static constexpr uint16_t STEERING_LEFT_US = 1000;
static constexpr uint16_t STEERING_CENTER_US = 1500;
static constexpr uint16_t STEERING_RIGHT_US = 2000;
```

Calibration steps:

1. Send steering `0.0` and adjust `STEERING_CENTER_US` until the wheels are physically centered.
2. Send steering `-1.0` and reduce/increase `STEERING_LEFT_US` so the linkage reaches full left without buzzing or binding.
3. Send steering `1.0` and tune `STEERING_RIGHT_US` the same way.
4. If movement is reversed, swap the left and right pulse constants or invert steering in firmware.

Use `STEERING_LIMIT`, for example `0.7f`, while testing to reduce travel.

## ESC / Throttle Calibration

Edit:

```cpp
static constexpr uint16_t THROTTLE_REVERSE_US = 1000;
static constexpr uint16_t THROTTLE_NEUTRAL_US = 1500;
static constexpr uint16_t THROTTLE_FORWARD_US = 2000;
```

Typical hobby ESCs expect:

- 1000 us: reverse or minimum throttle
- 1500 us: neutral
- 2000 us: forward or maximum throttle

Calibration steps:

1. Read your ESC manual first. Calibration procedures vary.
2. Keep the car lifted and remove pinion gear or disconnect motor phase wires if practical.
3. Confirm `throttle=0.0` outputs neutral and the motor does not move.
4. Use a low `THROTTLE_LIMIT`, for example `0.25f`, for first powered tests.
5. Increase forward and reverse ranges only after neutral and brake behavior are correct.

For one-way ESCs or DC motor drivers that do not support reverse, set `THROTTLE_REVERSE_US` equal to `THROTTLE_NEUTRAL_US` or replace `applyOutputs()` with the driver-specific direction/PWM logic.

## Debug Output

The sketch prints:

- Valid and invalid packet counts
- Last sequence number
- Failsafe state
- Current normalized throttle and steering
- Calculated steering and throttle pulse widths

Invalid JSON is ignored. The last valid command remains active until the 300 ms failsafe expires.

Debug logs share the control serial link. For long production runs where the Raspberry Pi is not reading ESP32 serial output, set:

```cpp
#define DEBUG_OUTPUT 0
```
