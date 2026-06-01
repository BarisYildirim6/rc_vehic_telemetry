#include <Arduino.h>
#include <ArduinoJson.h>

#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>
#endif

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

// Set to 0 only after steering and motor/ESC behavior are verified on the bench.
#define SIMULATION_MODE 1

// Debug uses the same Serial link as control input. Set to 0 for production if
// the Raspberry Pi is not reading ESP32 logs.
#define DEBUG_OUTPUT 1

// Serial transport. USB serial uses Serial on most ESP32 dev boards.
static constexpr uint32_t CONTROL_BAUD = 115200;
static constexpr uint32_t FAILSAFE_TIMEOUT_MS = 300;
static constexpr size_t MAX_LINE_LENGTH = 255;

// Hardware pins. Change these for your wiring.
static constexpr int STEERING_PIN = 18;
static constexpr int THROTTLE_PIN = 19;

// ESP32 LEDC PWM configuration for hobby servo/ESC style control.
static constexpr int STEERING_PWM_CHANNEL = 0;
static constexpr int THROTTLE_PWM_CHANNEL = 1;
static constexpr int PWM_FREQUENCY_HZ = 50;
static constexpr int PWM_RESOLUTION_BITS = 16;
static constexpr uint32_t PWM_PERIOD_US = 1000000UL / PWM_FREQUENCY_HZ;
static constexpr uint32_t PWM_MAX_DUTY = (1UL << PWM_RESOLUTION_BITS) - 1;

// Steering servo calibration.
static constexpr uint16_t STEERING_LEFT_US = 1000;
static constexpr uint16_t STEERING_CENTER_US = 1500;
static constexpr uint16_t STEERING_RIGHT_US = 2000;

// ESC or servo-style throttle calibration.
// Neutral is used for brake, failsafe, and throttle=0.
static constexpr uint16_t THROTTLE_REVERSE_US = 1000;
static constexpr uint16_t THROTTLE_NEUTRAL_US = 1500;
static constexpr uint16_t THROTTLE_FORWARD_US = 2000;

// Optional output limiting while testing. 0.50 limits commands to 50% travel.
static constexpr float STEERING_LIMIT = 1.0f;
static constexpr float THROTTLE_LIMIT = 1.0f;

static String lineBuffer;
static uint32_t lastValidPacketMs = 0;
static uint32_t lastDebugMs = 0;
static uint32_t validPackets = 0;
static uint32_t invalidPackets = 0;
static uint32_t lastSeq = 0;
static bool failsafeActive = true;
static bool brakeActive = true;
static float currentThrottle = 0.0f;
static float currentSteering = 0.0f;

static float clampUnit(float value) {
  if (isnan(value) || isinf(value)) {
    return 0.0f;
  }
  if (value > 1.0f) return 1.0f;
  if (value < -1.0f) return -1.0f;
  return value;
}

static float applyLimit(float value, float limit) {
  limit = clampUnit(limit);
  return clampUnit(value) * limit;
}

static uint32_t pulseUsToDuty(uint16_t pulseUs) {
  return static_cast<uint32_t>((static_cast<uint64_t>(pulseUs) * PWM_MAX_DUTY) / PWM_PERIOD_US);
}

static uint16_t mixPulse(float value, uint16_t minUs, uint16_t neutralUs, uint16_t maxUs) {
  value = clampUnit(value);
  if (value >= 0.0f) {
    return neutralUs + static_cast<uint16_t>((maxUs - neutralUs) * value);
  }
  return neutralUs - static_cast<uint16_t>((neutralUs - minUs) * -value);
}

static void writePwmUs(int target, uint16_t pulseUs) {
#if SIMULATION_MODE
  (void)target;
  (void)pulseUs;
#elif ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(target, pulseUsToDuty(pulseUs));
#else
  ledcWrite(target, pulseUsToDuty(pulseUs));
#endif
}

static void configurePwm() {
#if SIMULATION_MODE
#if DEBUG_OUTPUT
  Serial.println(F("SIMULATION_MODE=1: PWM outputs are disabled."));
#endif
#elif ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(STEERING_PIN, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS);
  ledcAttach(THROTTLE_PIN, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS);
#else
  ledcSetup(STEERING_PWM_CHANNEL, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS);
  ledcSetup(THROTTLE_PWM_CHANNEL, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS);
  ledcAttachPin(STEERING_PIN, STEERING_PWM_CHANNEL);
  ledcAttachPin(THROTTLE_PIN, THROTTLE_PWM_CHANNEL);
#endif
}

static void applyOutputs(float throttle, float steering, bool brake, const char *reason) {
  if (brake) {
    throttle = 0.0f;
    steering = 0.0f;
  }

  throttle = applyLimit(throttle, THROTTLE_LIMIT);
  steering = applyLimit(steering, STEERING_LIMIT);

  const uint16_t steeringUs = mixPulse(steering, STEERING_LEFT_US, STEERING_CENTER_US, STEERING_RIGHT_US);
  const uint16_t throttleUs = mixPulse(throttle, THROTTLE_REVERSE_US, THROTTLE_NEUTRAL_US, THROTTLE_FORWARD_US);

#if ESP_ARDUINO_VERSION_MAJOR >= 3
  writePwmUs(STEERING_PIN, steeringUs);
  writePwmUs(THROTTLE_PIN, throttleUs);
#else
  writePwmUs(STEERING_PWM_CHANNEL, steeringUs);
  writePwmUs(THROTTLE_PWM_CHANNEL, throttleUs);
#endif

  currentThrottle = throttle;
  currentSteering = steering;
  brakeActive = brake;

#if DEBUG_OUTPUT
  const uint32_t now = millis();
  if (now - lastDebugMs >= 200 || brake || failsafeActive) {
    Serial.print(F("out reason="));
    Serial.print(reason);
    Serial.print(F(" seq="));
    Serial.print(lastSeq);
    Serial.print(F(" throttle="));
    Serial.print(currentThrottle, 3);
    Serial.print(F(" steering="));
    Serial.print(currentSteering, 3);
    Serial.print(F(" brake="));
    Serial.print(brakeActive ? F("true") : F("false"));
    Serial.print(F(" steering_us="));
    Serial.print(steeringUs);
    Serial.print(F(" throttle_us="));
    Serial.print(throttleUs);
    Serial.print(F(" sim="));
    Serial.println(SIMULATION_MODE ? F("true") : F("false"));
    lastDebugMs = now;
  }
#endif
}

static bool parseBoolField(JsonVariant value, bool defaultValue) {
  if (value.is<bool>()) {
    return value.as<bool>();
  }
  if (value.is<const char *>()) {
    const char *text = value.as<const char *>();
    if (strcmp(text, "true") == 0) return true;
    if (strcmp(text, "false") == 0) return false;
  }
  return defaultValue;
}

static bool handlePacket(const String &line) {
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, line);
  if (error) {
#if DEBUG_OUTPUT
    Serial.print(F("invalid json: "));
    Serial.println(error.c_str());
#endif
    return false;
  }

  if (!doc["throttle"].is<float>() && !doc["throttle"].is<int>()) {
#if DEBUG_OUTPUT
    Serial.println(F("invalid packet: missing numeric throttle"));
#endif
    return false;
  }
  if (!doc["steering"].is<float>() && !doc["steering"].is<int>()) {
#if DEBUG_OUTPUT
    Serial.println(F("invalid packet: missing numeric steering"));
#endif
    return false;
  }

  const uint32_t seq = doc["seq"] | 0;
  const float throttle = clampUnit(doc["throttle"].as<float>());
  const float steering = clampUnit(doc["steering"].as<float>());
  const bool brake = parseBoolField(doc["brake"], false);
  const char *mode = doc["mode"] | "normal";
  const bool estop = brake || strcmp(mode, "estop") == 0;

  lastSeq = seq;
  lastValidPacketMs = millis();
  validPackets++;

  if (failsafeActive) {
#if DEBUG_OUTPUT
    Serial.println(F("failsafe cleared by valid packet"));
#endif
  }
  failsafeActive = false;

  applyOutputs(throttle, steering, estop, estop ? "estop" : "packet");
  return true;
}

static void readSerialLines() {
  while (Serial.available() > 0) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n') {
      if (lineBuffer.length() > 0) {
        if (!handlePacket(lineBuffer)) {
          invalidPackets++;
        }
        lineBuffer = "";
      }
    } else if (ch != '\r') {
      if (lineBuffer.length() < MAX_LINE_LENGTH) {
        lineBuffer += ch;
      } else {
        invalidPackets++;
#if DEBUG_OUTPUT
        Serial.println(F("invalid packet: line too long"));
#endif
        lineBuffer = "";
      }
    }
  }
}

static void updateFailsafe() {
  const uint32_t now = millis();
  if (!failsafeActive && now - lastValidPacketMs > FAILSAFE_TIMEOUT_MS) {
    failsafeActive = true;
#if DEBUG_OUTPUT
    Serial.println(F("failsafe active: no valid packet within 300 ms"));
#endif
    applyOutputs(0.0f, 0.0f, true, "failsafe");
  }
}

static void printHeartbeat() {
#if DEBUG_OUTPUT
  static uint32_t lastHeartbeatMs = 0;
  const uint32_t now = millis();
  if (now - lastHeartbeatMs < 1000) {
    return;
  }
  lastHeartbeatMs = now;

  Serial.print(F("status valid="));
  Serial.print(validPackets);
  Serial.print(F(" invalid="));
  Serial.print(invalidPackets);
  Serial.print(F(" failsafe="));
  Serial.print(failsafeActive ? F("true") : F("false"));
  Serial.print(F(" last_seq="));
  Serial.println(lastSeq);
#endif
}

void setup() {
  Serial.begin(CONTROL_BAUD);
  lineBuffer.reserve(MAX_LINE_LENGTH + 1);
  configurePwm();

  lastValidPacketMs = millis();
  failsafeActive = true;
  applyOutputs(0.0f, 0.0f, true, "boot");

#if DEBUG_OUTPUT
  Serial.println(F("ESP32 FPV receiver ready"));
  Serial.println(F("Protocol: newline-delimited JSON at 115200 baud"));
#endif
}

void loop() {
  readSerialLines();
  updateFailsafe();
  printHeartbeat();
}
