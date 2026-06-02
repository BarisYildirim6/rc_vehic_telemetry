const wsStatus = document.getElementById("wsStatus");
const serialMode = document.getElementById("serialMode");
const throttleValue = document.getElementById("throttleValue");
const steeringValue = document.getElementById("steeringValue");
const gamepadStatus = document.getElementById("gamepadStatus");
const throttleBar = document.getElementById("throttleBar");
const steeringBar = document.getElementById("steeringBar");
const estopButton = document.getElementById("estopButton");
const videoCommand = document.getElementById("videoCommand");
const fpvVideo = document.getElementById("fpvVideo");
const videoStatus = document.getElementById("videoStatus");
const videoOverlay = document.getElementById("videoOverlay");
const videoReconnectButton = document.getElementById("videoReconnectButton");
const latencyStatus = document.getElementById("latencyStatus");
const streamUrl = document.getElementById("streamUrl");
const parsedSendRate = Number(document.getElementById("sendRate").textContent || "50");
const sendRate = Number.isFinite(parsedSendRate) && parsedSendRate > 0 ? parsedSendRate : 50;
const controlIntervalMs = 1000 / sendRate;

let ws = null;
let reconnectTimer = null;
let keys = new Set();
let currentThrottle = 0;
let currentSteering = 0;
let brakeLatch = false;
let nextControlSend = performance.now();
let videoConfig = null;
let peerConnection = null;
let whepSessionUrl = null;
let videoConnectAbort = null;
let videoAutoConnectStarted = false;
let videoReconnectTimer = null;
let videoReconnectDelayMs = 1000;
let videoShuttingDown = false;

function clamp(value) {
  return Math.max(-1, Math.min(1, value));
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

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${window.location.host}/ws/control`);
  wsStatus.textContent = "Connecting";

  ws.addEventListener("open", () => {
    wsStatus.textContent = "Connected";
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.serial_mode) {
        serialMode.textContent = data.serial_mode;
      }
    } catch {
      // Ignore non-JSON diagnostics.
    }
  });

  ws.addEventListener("close", () => {
    wsStatus.textContent = "Disconnected";
    if (!reconnectTimer) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, 1000);
    }
  });

  ws.addEventListener("error", () => {
    wsStatus.textContent = "Error";
  });
}

function keyboardControl() {
  let throttle = 0;
  let steering = 0;
  if (keys.has("KeyW")) throttle += 1;
  if (keys.has("KeyS")) throttle -= 1;
  if (keys.has("KeyD")) steering += 1;
  if (keys.has("KeyA")) steering -= 1;
  return { throttle, steering };
}

function gamepadControl() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = Array.from(pads).find(Boolean);
  if (!pad) {
    gamepadStatus.textContent = "No controller detected";
    return null;
  }

  gamepadStatus.textContent = pad.id;
  const deadband = 0.08;
  const axis = (value) => (Math.abs(value) < deadband ? 0 : value);
  const steering = axis(pad.axes[0] || 0);
  const throttle = -axis(pad.axes[1] || 0);
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

function sendControl(throttle, steering, brake = false) {
  const payload = {
    throttle: clamp(throttle),
    steering: clamp(steering),
    brake: Boolean(brake),
    mode: brake ? "estop" : "normal",
  };

  currentThrottle = payload.brake ? 0 : payload.throttle;
  currentSteering = payload.brake ? 0 : payload.steering;
  updateReadout(currentThrottle, currentSteering);

  // Latency-sensitive path: keep this tiny and send the latest normalized state
  // at a fixed cadence. The server adds authoritative sequence and timestamp.
  if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4096) {
    ws.send(JSON.stringify(payload));
  }
}

async function triggerEstop() {
  brakeLatch = true;
  sendControl(0, 0, true);
  try {
    await fetch("/api/estop", { method: "POST" });
  } catch {
    // The WebSocket packet above is the primary path; REST is a backup command.
  }
  window.setTimeout(() => {
    brakeLatch = false;
  }, 250);
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    serialMode.textContent = data.serial?.mode || "unknown";
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
}

function mediaMtxHost() {
  const configuredHost = videoConfig?.host;
  if (configuredHost && configuredHost !== "0.0.0.0") {
    return configuredHost;
  }
  return window.location.hostname;
}

function buildMediaMtxUrl(suffix = "") {
  if (!videoConfig) {
    return "MediaMTX stream not configured";
  }
  const protocol = window.location.protocol === "https:" ? "https" : "http";
  const path = encodeURIComponent(videoConfig.path || "fpv");
  return `${protocol}://${mediaMtxHost()}:${videoConfig.webrtc_port}/${path}${suffix}`;
}

function buildRtspUrl() {
  if (!videoConfig) {
    return "RTSP stream not configured";
  }
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
}

function clearVideoReconnect() {
  if (videoReconnectTimer) {
    window.clearTimeout(videoReconnectTimer);
    videoReconnectTimer = null;
  }
}

function scheduleVideoReconnect(reason) {
  if (videoShuttingDown || !videoConfig || videoReconnectTimer) {
    return;
  }
  const delay = videoReconnectDelayMs;
  videoReconnectDelayMs = Math.min(videoReconnectDelayMs * 1.6, 5000);
  setVideoState("Disconnected", `${reason}; retrying in ${Math.round(delay / 1000)}s`);
  videoReconnectTimer = window.setTimeout(() => {
    videoReconnectTimer = null;
    connectVideo();
  }, delay);
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 2000);
    pc.addEventListener(
      "icegatheringstatechange",
      () => {
        if (pc.iceGatheringState === "complete") {
          window.clearTimeout(timeout);
          resolve();
        }
      },
      { once: false },
    );
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
      // Best-effort cleanup. MediaMTX also expires abandoned sessions.
    }
    whepSessionUrl = null;
  }

  if (peerConnection) {
    const oldConnection = peerConnection;
    peerConnection = null;
    oldConnection.close();
  }

  if (fpvVideo.srcObject) {
    for (const track of fpvVideo.srcObject.getTracks()) {
      track.stop();
    }
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
        if (pc !== peerConnection) {
          return;
        }
        closeVideoConnection();
        scheduleVideoReconnect("Video track ended");
      });
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc !== peerConnection) {
        return;
      }
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

    if (!response.ok) {
      throw new Error(`WHEP offer failed: HTTP ${response.status}`);
    }

    whepSessionUrl = response.headers.get("Location");
    if (whepSessionUrl && whepSessionUrl.startsWith("/")) {
      const base = new URL(buildMediaMtxUrl("/whep"));
      whepSessionUrl = `${base.origin}${whepSessionUrl}`;
    }

    const answer = await response.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    console.error(error);
    setVideoState("Disconnected", "WebRTC failed; use fallback");
    latencyStatus.textContent = "Unavailable";
    scheduleVideoReconnect("WebRTC failed");
  } finally {
    if (abort && videoConnectAbort === abort) {
      videoConnectAbort = null;
    }
  }
}

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    triggerEstop();
    return;
  }
  keys.add(event.code);
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

estopButton.addEventListener("click", triggerEstop);
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

function controlTick() {
  const control = mergedControl();
  sendControl(control.throttle, control.steering, brakeLatch || control.brake);

  nextControlSend += controlIntervalMs;
  const now = performance.now();
  if (nextControlSend < now - controlIntervalMs) {
    nextControlSend = now + controlIntervalMs;
  }
  window.setTimeout(controlTick, Math.max(0, nextControlSend - now));
}

window.setTimeout(controlTick, 0);
