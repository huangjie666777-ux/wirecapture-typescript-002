# fairgate

A local Python library exercise for a fixed-capacity asynchronous weighted
permit pool. The public interface skeleton lives in `fairgate/pool.py`.
It has no implementation yet. Use Python 3.10 or later and the standard library.
No package installation, network service, credentials, or port is required.

The task prompt defines validation, FIFO admission, cancellation recovery,
permit ownership, and graceful shutdown. A granted request owns its allocation
even before its acquire coroutine returns. Pending requests that have not been
granted an allocation are rejected when closing starts.

Required usage:

```python
from fairgate import WeightedPool

async def example():
    pool = WeightedPool(3)
    async with await pool.acquire(2):
        pass
    await pool.aclose()
```

Add tests discoverable with `python3 -m unittest discover -s tests -v` and a
`demo.py` runnable with `python3 demo.py`. This repository is a library, not
a command-line application.
