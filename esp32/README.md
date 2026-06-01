# ESP32 Receiver Stub

`arduino_receiver_stub/arduino_receiver_stub.ino` is a first-pass Arduino sketch for testing the serial protocol.

Install the `ArduinoJson` library in Arduino IDE or PlatformIO before compiling. The stub reads newline-delimited JSON from `Serial`, clamps throttle and steering, and includes TODOs for servo/ESC output and the 300 ms failsafe.

Connection options:

- USB serial: connect the ESP32 to the Raspberry Pi over USB and set `serial.port` to `/dev/ttyUSB0` or `/dev/ttyACM0`.
- UART: connect Pi TX/RX/GND to an ESP32 hardware serial port, use proper 3.3 V logic, and avoid powering motors from the Pi.

