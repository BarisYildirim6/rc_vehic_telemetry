from __future__ import annotations

import argparse
import asyncio
import json
import math
import time

import websockets


async def run(url: str, hz: int, seconds: float) -> None:
    interval = 1.0 / hz
    deadline = time.monotonic() + seconds
    seq = 0
    async with websockets.connect(url) as ws:
        while time.monotonic() < deadline:
            phase = time.monotonic()
            payload = {
                "throttle": 0.35 * math.sin(phase),
                "steering": 0.75 * math.sin(phase * 1.7),
                "brake": False,
                "mode": "normal",
            }
            await ws.send(json.dumps(payload))
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=0.2)
                if seq % hz == 0:
                    print(message)
            except TimeoutError:
                pass
            seq += 1
            await asyncio.sleep(interval)

        await ws.send(json.dumps({"throttle": 0, "steering": 0, "brake": True, "mode": "estop"}))


def main() -> None:
    parser = argparse.ArgumentParser(description="Send test control packets to the FPV backend.")
    parser.add_argument("--url", default="ws://127.0.0.1:8000/ws/control")
    parser.add_argument("--hz", type=int, default=50)
    parser.add_argument("--seconds", type=float, default=10.0)
    args = parser.parse_args()
    asyncio.run(run(args.url, args.hz, args.seconds))


if __name__ == "__main__":
    main()

