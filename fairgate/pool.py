"""Interface skeleton; implement the behavior described in the task."""

from __future__ import annotations


class PoolClosed(Exception):
    """An otherwise valid acquire cannot enter a closed pool."""


class Permit:
    """One allocation returned by WeightedPool.acquire; release is idempotent."""

    def release(self) -> None:
        raise NotImplementedError

    async def __aenter__(self) -> Permit:
        raise NotImplementedError

    async def __aexit__(self, exc_type, exc, tb) -> None:
        raise NotImplementedError


class WeightedPool:
    """Fixed capacity, strict FIFO admission on a single asyncio event loop."""

    def __init__(self, capacity: int):
        raise NotImplementedError

    async def acquire(self, weight: int = 1) -> Permit:
        raise NotImplementedError

    async def aclose(self) -> None:
        raise NotImplementedError
