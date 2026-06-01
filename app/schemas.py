from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator


Mode = Literal["normal", "estop"]


def clamp_unit(value: float) -> float:
    return max(-1.0, min(1.0, float(value)))


class ClientControlPacket(BaseModel):
    throttle: float = Field(default=0.0)
    steering: float = Field(default=0.0)
    brake: bool = Field(default=False)
    mode: Mode = Field(default="normal")

    @field_validator("throttle", "steering", mode="before")
    @classmethod
    def coerce_and_clamp(cls, value: Any) -> float:
        return clamp_unit(float(value))


class SerialControlPacket(BaseModel):
    seq: int
    throttle: float
    steering: float
    brake: bool
    mode: Mode
    ts: int


def parse_client_packet(data: dict[str, Any]) -> ClientControlPacket:
    try:
        return ClientControlPacket.model_validate(data)
    except (TypeError, ValueError, ValidationError) as exc:
        raise ValueError(f"invalid control packet: {exc}") from exc

