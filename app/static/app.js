const wsStatus = document.getElementById("wsStatus");
const serialMode = document.getElementById("serialMode");
const throttleValue = document.getElementById("throttleValue");
const steeringValue = document.getElementById("steeringValue");
const gamepadStatus = document.getElementById("gamepadStatus");
const throttleBar = document.getElementById("throttleBar");
const steeringBar = document.getElementById("steeringBar");
const estopButton = document.getElementById("estopButton");
const videoCommand = document.getElementById("videoCommand");
const sendRate = Number(document.getElementById("sendRate").textContent || "50");

let ws = null;
let reconnectTimer = null;
let keys = new Set();
let currentThrottle = 0;
let currentSteering = 0;
let brakeLatch = false;
let nextControlSend = performance.now();

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
    if (data.video?.udp_command) {
      videoCommand.textContent = data.video.udp_command;
    }
  } catch {
    serialMode.textContent = "unknown";
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

connectWebSocket();
refreshStatus();
window.setInterval(refreshStatus, 1000);

function controlTick() {
  const control = mergedControl();
  sendControl(control.throttle, control.steering, brakeLatch || control.brake);

  const intervalMs = 1000 / sendRate;
  nextControlSend += intervalMs;
  const now = performance.now();
  if (nextControlSend < now - intervalMs) {
    nextControlSend = now + intervalMs;
  }
  window.setTimeout(controlTick, Math.max(0, nextControlSend - now));
}

window.setTimeout(controlTick, 0);
