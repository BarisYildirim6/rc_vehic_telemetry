from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator


SerialMode = Literal["normal", "estop"]
DriveMode = Literal["bench", "crawl", "normal", "sport"]


def clamp_unit(value: float) -> float:
    if not math.isfinite(value):
        raise ValueError("control value must be finite")
    return max(-1.0, min(1.0, float(value)))


class ClientControlPacket(BaseModel):
    type: str = Field(default="control")
    seq: int | None = Field(default=None)
    throttle: float = Field(default=0.0)
    steering: float = Field(default=0.0)
    brake: bool = Field(default=False)
    armed: bool | None = Field(default=None)
    estop: bool | None = Field(default=None)
    mode: DriveMode | SerialMode | None = Field(default=None)
    client_ts: int | None = Field(default=None)

    @field_validator("throttle", "steering", mode="before")
    @classmethod
    def coerce_and_clamp(cls, value: Any) -> float:
        return clamp_unit(float(value))


class SerialControlPacket(BaseModel):
    seq: int
    throttle: float
    steering: float
    brake: bool
    mode: SerialMode
    armed: bool = False
    estop: bool = False
    drive_mode: DriveMode = "bench"
    ts: int


def parse_client_packet(data: dict[str, Any]) -> ClientControlPacket:
    try:
        return ClientControlPacket.model_validate(data)
    except (TypeError, ValueError, ValidationError) as exc:
        raise ValueError(f"invalid control packet: {exc}") from exc
