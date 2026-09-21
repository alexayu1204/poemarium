from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import config

ROLE_NAMES = {"connect": "connector", "reframe": "reframer"}


@dataclass
class Result:
    text: str
    provider: str
    model: str
    latency_ms: int
    response_id: str | None = None
    usage: dict | None = None
    finish: str | None = None
    raw: dict | None = None


class MediationError(RuntimeError):
    def __init__(self, message: str, provider: str, model: str, latency_ms: int):
        super().__init__(message)
        self.provider = provider
        self.model = model
        self.latency_ms = latency_ms


#Providers receive structured input without a text template.
class Provider(Protocol):
    name: str
    model: str
    decoding: dict

    def describe(self) -> dict: ...
    def generate(self, role: str, inputs: dict) -> Result: ...


class PlaceholderProvider:
    name = "placeholder"
    model = "MODEL_PLACEHOLDER"
    available = False

    def __init__(self):
        self.decoding = dict(config.MEDIATION_DECODING)

    def describe(self) -> dict:
        return {
            "provider": self.name,
            "model": self.model,
            "available": self.available,
            "decoding": self.decoding,
        }

    def generate(self, role: str, inputs: dict) -> Result:
        raise MediationError(
            "No interpretation model is configured.", self.name, self.model, 0
        )


def make_provider() -> Provider:
    return PlaceholderProvider()
