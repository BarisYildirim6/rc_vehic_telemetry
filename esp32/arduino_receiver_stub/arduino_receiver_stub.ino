#include <Arduino.h>
#include <ArduinoJson.h>

static constexpr uint32_t BAUD_RATE = 115200;
static constexpr uint32_t FAILSAFE_MS = 300;
static String lineBuffer;
static uint32_t lastValidPacketMs = 0;

static float clampUnit(float value) {
  if (value > 1.0f) return 1.0f;
  if (value < -1.0f) return -1.0f;
  return value;
}

static void applyControl(float throttle, float steering, bool brake) {
  throttle = brake ? 0.0f : clampUnit(throttle);
  steering = brake ? 0.0f : clampUnit(steering);

  // TODO: Map normalized throttle to ESC or motor driver PWM.
  // TODO: Map normalized steering to servo PWM.
  // TODO: Ensure brake=true disables motor output immediately.
}

static void handleLine(const String &line) {
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, line);
  if (error) {
    return;
  }

  float throttle = clampUnit(doc["throttle"] | 0.0f);
  float steering = clampUnit(doc["steering"] | 0.0f);
  bool brake = doc["brake"] | false;
  const char *mode = doc["mode"] | "normal";

  if (brake || strcmp(mode, "estop") == 0) {
    applyControl(0.0f, 0.0f, true);
  } else {
    applyControl(throttle, steering, false);
  }
  lastValidPacketMs = millis();
}

void setup() {
  Serial.begin(BAUD_RATE);
  lineBuffer.reserve(256);
  lastValidPacketMs = millis();
}

void loop() {
  while (Serial.available() > 0) {
    char ch = static_cast<char>(Serial.read());
    if (ch == '\n') {
      handleLine(lineBuffer);
      lineBuffer = "";
    } else if (ch != '\r' && lineBuffer.length() < 255) {
      lineBuffer += ch;
    }
  }

  // TODO: This is the mandatory ESP32-side failsafe for real motor output.
  if (millis() - lastValidPacketMs > FAILSAFE_MS) {
    applyControl(0.0f, 0.0f, true);
  }
}

