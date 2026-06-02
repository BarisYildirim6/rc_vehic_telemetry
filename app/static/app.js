const wsStatus = document.getElementById("wsStatus");
const serialMode = document.getElementById("serialMode");
const throttleValue = document.getElementById("throttleValue");
const steeringValue = document.getElementById("steeringValue");
const gamepadStatus = document.getElementById("gamepadStatus");
const throttleBar = document.getElementById("throttleBar");
const steeringBar = document.getElementById("steeringBar");
const estopButton = document.getElementById("estopButton");
const armButton = document.getElementById("armButton");
const clearEstopButton = document.getElementById("clearEstopButton");
const videoCommand = document.getElementById("videoCommand");
const fpvVideo = document.getElementById("fpvVideo");
const videoStatus = document.getElementById("videoStatus");
const videoOverlay = document.getElementById("videoOverlay");
const videoReconnectButton = document.getElementById("videoReconnectButton");
const latencyStatus = document.getElementById("latencyStatus");
const streamUrl = document.getElementById("streamUrl");
const modeButtons = Array.from(document.querySelectorAll(".mode-button"));
const hudThrottle = document.getElementById("hudThrottle");
const hudSteering = document.getElementById("hudSteering");
const hudMode = document.getElementById("hudMode");
const hudArmed = document.getElementById("hudArmed");
const hudEstop = document.getElementById("hudEstop");
const hudFailsafe = document.getElementById("hudFailsafe");
const hudWs = document.getElementById("hudWs");
const hudVideo = document.getElementById("hudVideo");
const hudSerial = document.getElementById("hudSerial");
const hudTelemetry = document.getElementById("hudTelemetry");
const hudRtt = document.getElementById("hudRtt");
const hudJitter = document.getElementById("hudJitter");
const hudRate = document.getElementById("hudRate");
const hudAge = document.getElementById("hudAge");

const parsedSendRate = Number(document.getElementById("sendRate").textContent || "50");
const sendRate = Number.isFinite(parsedSendRate) && parsedSendRate > 0 ? parsedSendRate : 50;
const controlIntervalMs = 1000 / sendRate;

const GAMEPAD_CONFIG = {
  steeringAxis: 0,
  throttleAxis: 1,
  invertThrottle: true,
  deadzone: 0.08,
  expo: 0.35,
};

const DRIVE_MODES = {
  bench: { label: "Bench", maxThrottle: 0.0, maxSteering: 0.6, ramp: 0.8 },
  crawl: { label: "Crawl", maxThrottle: 0.25, maxSteering: 0.6, ramp: 0.9 },
  normal: { label: "Normal", maxThrottle: 0.6, maxSteering: 0.85, ramp: 1.8 },
  sport: { label: "Sport", maxThrottle: 1.0, maxSteering: 1.0, ramp: 3.5 },
};

const STEERING_REDUCTION = {
  enabled: true,
  startThrottle: 0.45,
  minSteeringScale: 0.55,
};

let ws = null;
let reconnectTimer = null;
let keys = new Set();
let driveMode = "bench";
let armed = false;
let estop = false;
let currentThrottle = 0;
let currentSteering = 0;
let targetThrottle = 0;
let targetSteering = 0;
let nextControlSend = performance.now() + controlIntervalMs;
let lastControlTick = performance.now();
let controlSeq = 0;
let pingSeq = 0;
let pendingPings = new Map();
let rttSamples = [];
let jitterMs = null;
let sentThisSecond = 0;
let measuredSendRate = 0;
let lastRateWindow = performance.now();
let lastServerStatus = null;

let videoConfig = null;
let peerConnection = null;
let whepSessionUrl = null;
let videoConnectAbort = null;
let videoAutoConnectStarted = false;
let videoReconnectTimer = null;
let videoReconnectDelayMs = 1000;
let videoShuttingDown = false;

function clamp(value, min = -1, max = 1) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

function applyDeadzone(value, deadzone) {
  value = clamp(value);
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  const scaled = (magnitude - deadzone) / (1 - deadzone);
  return Math.sign(value) * clamp(scaled);
}

function applyExpo(value, expoAmount) {
  value = clamp(value);
  expoAmount = clamp(expoAmount, 0, 1);
  return value * (1 - expoAmount) + value * value * value * expoAmount;
}

function rateLimit(current, target, maxDeltaPerSecond, dt) {
  const maxDelta = Math.max(0, maxDeltaPerSecond) * Math.max(0, dt);
  return current + clamp(target - current, -maxDelta, maxDelta);
}

function applyDriveModeLimits(throttle, steering, mode) {
  const limits = DRIVE_MODES[mode] || DRIVE_MODES.bench;
  let limitedThrottle = clamp(throttle) * limits.maxThrottle;
  let limitedSteering = clamp(steering) * limits.maxSteering;

  if (STEERING_REDUCTION.enabled) {
    const throttleAbs = Math.abs(limitedThrottle);
    if (throttleAbs > STEERING_REDUCTION.startThrottle) {
      const span = 1 - STEERING_REDUCTION.startThrottle;
      const amount = clamp((throttleAbs - STEERING_REDUCTION.startThrottle) / span, 0, 1);
      const scale = 1 - amount * (1 - STEERING_REDUCTION.minSteeringScale);
      limitedSteering *= scale;
    }
  }

  return { throttle: limitedThrottle, steering: limitedSteering };
}

function isThrottleNeutral() {
  return Math.abs(targetThrottle) <= 0.01 && Math.abs(currentThrottle) <= 0.01;
}

function setBar(element, value) {
  const magnitude = Math.abs(value) * 50;
  element.style.width = `${magnitude}%`;
  element.classList.toggle("negative", value < 0);
}

function updateReadout(throttle, steering) {
  throttleValue.textContent = throttle.toFixed(2);
  steeringValue.textContent = steering.toFixed(2);
  setBar(throttleBar, throttle);
  setBar(steeringBar, steering);
}

function updateHud() {
  const modeLabel = DRIVE_MODES[driveMode]?.label || driveMode;
  const telemetry = lastServerStatus?.telemetry || {};
  hudThrottle.textContent = `${Math.round(currentThrottle * 100)}%`;
  hudSteering.textContent = `${Math.round(currentSteering * 100)}%`;
  hudMode.textContent = modeLabel;
  hudArmed.textContent = armed ? "ARMED" : "DISARMED";
  hudEstop.textContent = estop ? "ACTIVE" : "CLEAR";
  hudFailsafe.textContent =
    typeof telemetry.failsafe === "boolean" ? (telemetry.failsafe ? "ACTIVE" : "CLEAR") : "--";
  hudWs.textContent = wsStatus.textContent;
  hudVideo.textContent = videoStatus.textContent;
  hudSerial.textContent = serialMode.textContent;
  hudTelemetry.textContent = telemetry.mock ? "MOCK" : telemetry.source || "--";
  hudRate.textContent = `${measuredSendRate.toFixed(1)} Hz`;
  hudAge.textContent = formatAge(lastServerStatus?.last_command_age_ms);

  const rtt = rttStats();
  hudRtt.textContent =
    rtt.last === null
      ? "--"
      : `${Math.round(rtt.last)}/${Math.round(rtt.avg)}/${Math.round(rtt.min)}/${Math.round(rtt.max)} ms`;
  hudJitter.textContent = jitterMs === null ? "--" : `${Math.round(jitterMs)} ms`;

  armButton.textContent = armed ? "Disarm" : "Arm";
  modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === driveMode));
  setStateClass(hudArmed, armed ? "info" : "warn");
  setStateClass(hudEstop, estop ? "danger" : "ok");
  setStateClass(hudFailsafe, typeof telemetry.failsafe === "boolean" ? (telemetry.failsafe ? "danger" : "ok") : "warn");
  setStateClass(hudWs, wsStatus.textContent === "Connected" ? "ok" : "warn");
  setStateClass(hudVideo, videoStatus.textContent === "Connected" ? "ok" : "warn");
  setStateClass(hudSerial, serialMode.textContent === "mock" ? "warn" : "ok");
  setStateClass(hudTelemetry, telemetry.mock ? "warn" : "ok");
}

function setStateClass(element, state) {
  element.classList.remove("state-ok", "state-warn", "state-danger", "state-info");
  element.classList.add(`state-${state}`);
}

function formatAge(value) {
  if (value === null || value === undefined) return "--";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function setWsState(label) {
  wsStatus.textContent = label;
  updateHud();
}

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${window.location.host}/ws/control`);
  setWsState("Connecting");

  ws.addEventListener("open", () => {
    setWsState("Connected");
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    } catch {
      // Ignore non-JSON diagnostics.
    }
  });

  ws.addEventListener("close", () => {
    armed = false;
    setWsState("Disconnected");
    if (!reconnectTimer) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, 1000);
    }
  });

  ws.addEventListener("error", () => {
    setWsState("Error");
  });
}

function handleServerMessage(data) {
  if (data.type === "pong") {
    handlePong(data);
    return;
  }
  if (data.type === "status") {
    applyServerStatus(data);
    return;
  }
  if (data.type === "ack") {
    if (typeof data.armed === "boolean") armed = data.armed;
    if (typeof data.estop === "boolean") estop = data.estop;
    if (data.mode && DRIVE_MODES[data.mode]) driveMode = data.mode;
    if (data.serial_mode) serialMode.textContent = data.serial_mode;
    updateHud();
    return;
  }
  if (["arm", "mode", "estop", "clear_estop"].includes(data.type)) {
    if (typeof data.armed === "boolean") armed = data.armed;
    if (typeof data.estop === "boolean") estop = data.estop;
    if (data.mode && DRIVE_MODES[data.mode]) driveMode = data.mode;
    updateHud();
  }
}

function applyServerStatus(data) {
  lastServerStatus = data;
  if (typeof data.armed === "boolean") armed = data.armed;
  if (typeof data.estop === "boolean") estop = data.estop;
  if (data.mode && DRIVE_MODES[data.mode]) driveMode = data.mode;
  if (data.serial?.mode) serialMode.textContent = data.serial.mode;
  if (data.telemetry?.mock) serialMode.textContent = "mock";
  updateHud();
}

function handlePong(data) {
  const sentAt = pendingPings.get(data.seq);
  if (!sentAt) return;
  pendingPings.delete(data.seq);

  const rtt = performance.now() - sentAt;
  const previous = rttSamples.length ? rttSamples[rttSamples.length - 1] : null;
  if (previous !== null) {
    const delta = Math.abs(rtt - previous);
    jitterMs = jitterMs === null ? delta : jitterMs * 0.8 + delta * 0.2;
  }
  rttSamples.push(rtt);
  if (rttSamples.length > 60) rttSamples.shift();
  updateHud();
}

function rttStats() {
  if (!rttSamples.length) return { last: null, avg: null, min: null, max: null };
  const sum = rttSamples.reduce((acc, value) => acc + value, 0);
  return {
    last: rttSamples[rttSamples.length - 1],
    avg: sum / rttSamples.length,
    min: Math.min(...rttSamples),
    max: Math.max(...rttSamples),
  };
}

function keyboardControl() {
  let throttle = 0;
  let steering = 0;
  if (keys.has("KeyW")) throttle += 1;
  if (keys.has("KeyS")) throttle -= 1;
  if (keys.has("KeyD")) steering += 1;
  if (keys.has("KeyA")) steering -= 1;
  return { throttle, steering, brake: false };
}

function gamepadControl() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = Array.from(pads).find(Boolean);
  if (!pad) {
    gamepadStatus.textContent = "No controller detected";
    return null;
  }

  gamepadStatus.textContent = pad.id;
  const rawSteering = pad.axes[GAMEPAD_CONFIG.steeringAxis] || 0;
  const rawThrottle = pad.axes[GAMEPAD_CONFIG.throttleAxis] || 0;
  const throttleSign = GAMEPAD_CONFIG.invertThrottle ? -1 : 1;
  const steering = rawSteering;
  const throttle = rawThrottle * throttleSign;
  const brake = pad.buttons.some((button, index) => index < 4 && button.pressed);
  return { throttle, steering, brake };
}

function mergedControl() {
  const keyboard = keyboardControl();
  const gamepad = gamepadControl();
  if (gamepad && (Math.abs(gamepad.throttle) > 0 || Math.abs(gamepad.steering) > 0 || gamepad.brake)) {
    return gamepad;
  }
  return keyboard;
}

function sendWs(payload) {
  if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4096) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function sendControl(throttle, steering, brake = false) {
  const payload = {
    type: "control",
    seq: ++controlSeq,
    throttle: clamp(throttle),
    steering: clamp(steering),
    brake: Boolean(brake || estop),
    armed,
    estop,
    mode: driveMode,
    client_ts: Date.now(),
  };

  updateReadout(payload.throttle, payload.steering);
  if (sendWs(payload)) {
    sentThisSecond++;
  }
}

async function triggerEstop() {
  estop = true;
  armed = false;
  currentThrottle = 0;
  targetThrottle = 0;
  sendWs({ type: "estop", seq: ++controlSeq, client_ts: Date.now() });
  sendControl(0, 0, true);
  try {
    await fetch("/api/estop", { method: "POST" });
  } catch {
    // WebSocket is the primary path; REST is a backup command.
  }
  updateHud();
}

async function clearEstop() {
  if (!isThrottleNeutral()) return;
  try {
    await fetch("/api/clear-estop", { method: "POST" });
  } catch {
    // Keep the WebSocket path as the primary cockpit control channel.
  }
  sendWs({ type: "clear_estop", seq: ++controlSeq, client_ts: Date.now() });
}

function setDriveMode(mode) {
  if (!DRIVE_MODES[mode]) return;
  driveMode = mode;
  if (mode === "bench") {
    currentThrottle = 0;
    targetThrottle = 0;
  }
  sendWs({ type: "mode", mode, seq: ++controlSeq, client_ts: Date.now() });
  updateHud();
}

async function toggleArm() {
  if (!isThrottleNeutral()) return;
  const nextArmed = !armed;
  sendWs({ type: "arm", armed: nextArmed, seq: ++controlSeq, client_ts: Date.now() });
  try {
    await fetch("/api/arm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ armed: nextArmed }),
    });
  } catch {
    // WebSocket state message is already sent.
  }
}

function sendPing() {
  const seq = ++pingSeq;
  pendingPings.set(seq, performance.now());
  sendWs({ type: "ping", seq, client_ts: Date.now() });
  for (const [key, sentAt] of pendingPings.entries()) {
    if (performance.now() - sentAt > 5000) pendingPings.delete(key);
  }
}

function updateSendRateWindow() {
  const now = performance.now();
  const elapsed = (now - lastRateWindow) / 1000;
  if (elapsed >= 1) {
    measuredSendRate = sentThisSecond / elapsed;
    sentThisSecond = 0;
    lastRateWindow = now;
    updateHud();
  }
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    serialMode.textContent = data.serial?.mode || "unknown";
    if (data.control) {
      applyServerStatus({ type: "status", ...data.control });
    }
    if (data.video?.mediamtx) {
      videoConfig = data.video.mediamtx;
      updateVideoUrls();
      if (!videoAutoConnectStarted) {
        videoAutoConnectStarted = true;
        connectVideo();
      }
    }
    if (data.video?.mediamtx_ingest_command) {
      videoCommand.textContent = [
        `WebRTC page: ${buildMediaMtxUrl("")}`,
        `RTSP: ${buildRtspUrl()}`,
        `Publisher: ${data.video.mediamtx_ingest_command}`,
      ].join("\n");
    }
  } catch {
    serialMode.textContent = "unknown";
  }
  updateHud();
}

function mediaMtxHost() {
  const configuredHost = videoConfig?.host;
  if (configuredHost && configuredHost !== "0.0.0.0") return configuredHost;
  return window.location.hostname;
}

function buildMediaMtxUrl(suffix = "") {
  if (!videoConfig) return "MediaMTX stream not configured";
  const protocol = window.location.protocol === "https:" ? "https" : "http";
  const path = encodeURIComponent(videoConfig.path || "fpv");
  return `${protocol}://${mediaMtxHost()}:${videoConfig.webrtc_port}/${path}${suffix}`;
}

function buildRtspUrl() {
  if (!videoConfig) return "RTSP stream not configured";
  const path = encodeURIComponent(videoConfig.path || "fpv");
  return `rtsp://${mediaMtxHost()}:${videoConfig.rtsp_port}/${path}`;
}

function updateVideoUrls() {
  streamUrl.textContent = buildMediaMtxUrl("/whep");
}

function setVideoState(state, overlayText = "") {
  videoStatus.textContent = state;
  videoOverlay.textContent = overlayText || state;
  videoOverlay.classList.toggle("hidden", state === "Connected");
  updateHud();
}

function clearVideoReconnect() {
  if (videoReconnectTimer) {
    window.clearTimeout(videoReconnectTimer);
    videoReconnectTimer = null;
  }
}

function scheduleVideoReconnect(reason) {
  if (videoShuttingDown || !videoConfig || videoReconnectTimer) return;
  const delay = videoReconnectDelayMs;
  videoReconnectDelayMs = Math.min(videoReconnectDelayMs * 1.6, 5000);
  setVideoState("Disconnected", `${reason}; retrying in ${Math.round(delay / 1000)}s`);
  videoReconnectTimer = window.setTimeout(() => {
    videoReconnectTimer = null;
    connectVideo();
  }, delay);
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 2000);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        window.clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function closeVideoConnection() {
  if (videoConnectAbort) {
    videoConnectAbort.abort();
    videoConnectAbort = null;
  }
  if (whepSessionUrl) {
    try {
      await fetch(whepSessionUrl, { method: "DELETE" });
    } catch {
      // Best-effort cleanup.
    }
    whepSessionUrl = null;
  }
  if (peerConnection) {
    const oldConnection = peerConnection;
    peerConnection = null;
    oldConnection.close();
  }
  if (fpvVideo.srcObject) {
    for (const track of fpvVideo.srcObject.getTracks()) track.stop();
    fpvVideo.srcObject = null;
  }
}

async function connectVideo() {
  if (!videoConfig) {
    setVideoState("Disconnected", "Waiting for stream config");
    return;
  }

  clearVideoReconnect();
  await closeVideoConnection();
  setVideoState("Connecting", "Connecting to WebRTC stream");
  latencyStatus.textContent = "Test pending";

  if (!window.RTCPeerConnection) {
    setVideoState("Disconnected", "WebRTC unsupported");
    latencyStatus.textContent = "Unavailable";
    return;
  }

  let abort = null;
  try {
    abort = new AbortController();
    videoConnectAbort = abort;
    const pc = new RTCPeerConnection({ iceServers: [] });
    peerConnection = pc;

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addEventListener("track", (event) => {
      fpvVideo.srcObject = event.streams[0];
      fpvVideo.play().catch(() => {});
      event.track.addEventListener("ended", () => {
        if (pc !== peerConnection) return;
        closeVideoConnection();
        scheduleVideoReconnect("Video track ended");
      });
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc !== peerConnection) return;
      if (pc.connectionState === "connected") {
        videoReconnectDelayMs = 1000;
        setVideoState("Connected");
        latencyStatus.textContent = "Placeholder";
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        closeVideoConnection();
        scheduleVideoReconnect(`Video ${pc.connectionState}`);
      } else if (pc.connectionState === "closed") {
        setVideoState("Disconnected", "Video disconnected");
      } else {
        setVideoState("Connecting", pc.connectionState);
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const response = await fetch(buildMediaMtxUrl("/whep"), {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription.sdp,
      signal: abort.signal,
    });
    if (!response.ok) throw new Error(`WHEP offer failed: HTTP ${response.status}`);

    whepSessionUrl = response.headers.get("Location");
    if (whepSessionUrl && whepSessionUrl.startsWith("/")) {
      const base = new URL(buildMediaMtxUrl("/whep"));
      whepSessionUrl = `${base.origin}${whepSessionUrl}`;
    }

    await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error(error);
    setVideoState("Disconnected", "WebRTC failed; use fallback");
    latencyStatus.textContent = "Unavailable";
    scheduleVideoReconnect("WebRTC failed");
  } finally {
    if (abort && videoConnectAbort === abort) videoConnectAbort = null;
  }
}

window.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  if (event.code === "Space") {
    event.preventDefault();
    triggerEstop();
    return;
  }
  if (event.code === "KeyR") {
    clearEstop();
    return;
  }
  if (event.code === "Enter") {
    event.preventDefault();
    toggleArm();
    return;
  }
  if (event.code === "Digit1") return setDriveMode("bench");
  if (event.code === "Digit2") return setDriveMode("crawl");
  if (event.code === "Digit3") return setDriveMode("normal");
  if (event.code === "Digit4") return setDriveMode("sport");
  keys.add(event.code);
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

estopButton.addEventListener("click", triggerEstop);
clearEstopButton.addEventListener("click", clearEstop);
armButton.addEventListener("click", toggleArm);
modeButtons.forEach((button) => button.addEventListener("click", () => setDriveMode(button.dataset.mode)));
videoReconnectButton.addEventListener("click", () => {
  videoReconnectDelayMs = 1000;
  connectVideo();
});
window.addEventListener("beforeunload", () => {
  videoShuttingDown = true;
  clearVideoReconnect();
  closeVideoConnection();
});

connectWebSocket();
refreshStatus();
window.setInterval(refreshStatus, 1000);
window.setInterval(sendPing, 1000);

function controlTick() {
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0.001, (now - lastControlTick) / 1000));
  lastControlTick = now;

  const control = mergedControl();
  if (control.brake && !estop) {
    triggerEstop();
  }

  const shapedThrottle = applyExpo(applyDeadzone(control.throttle, GAMEPAD_CONFIG.deadzone), GAMEPAD_CONFIG.expo);
  const shapedSteering = applyExpo(applyDeadzone(control.steering, GAMEPAD_CONFIG.deadzone), GAMEPAD_CONFIG.expo);
  const limited = applyDriveModeLimits(shapedThrottle, shapedSteering, driveMode);
  targetThrottle = estop || !armed ? 0 : limited.throttle;
  targetSteering = estop ? 0 : limited.steering;

  const ramp = DRIVE_MODES[driveMode]?.ramp || DRIVE_MODES.bench.ramp;
  currentThrottle = rateLimit(currentThrottle, targetThrottle, ramp, dt);
  currentSteering = rateLimit(currentSteering, targetSteering, ramp * 2, dt);

  sendControl(currentThrottle, currentSteering, estop);
  updateSendRateWindow();
  updateHud();

  nextControlSend += controlIntervalMs;
  const scheduleNow = performance.now();
  if (nextControlSend < scheduleNow - controlIntervalMs) {
    nextControlSend = scheduleNow + controlIntervalMs;
  }
  window.setTimeout(controlTick, Math.max(0, nextControlSend - scheduleNow));
}

updateHud();
window.setTimeout(controlTick, controlIntervalMs);
