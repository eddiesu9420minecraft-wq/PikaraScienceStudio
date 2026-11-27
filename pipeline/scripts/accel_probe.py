"""Measure which AI accelerators really work on this machine (no guessing from names or OS):

    python scripts/accel_probe.py [--out <file.json>] [--size 2048]

For each backend it imports the library *and* runs a real fp32 matmul on the device, checks the result against
the CPU, and times it. A backend is "ok" only if that computation succeeded and matched.

  * torch CUDA   — NVIDIA (Windows / Linux)
  * torch MPS    — Apple GPU through Metal Performance Shaders (macOS 12.3+, Apple Silicon or AMD on Intel Macs)
  * MLX          — Apple's array framework on Metal (Apple Silicon only)
  * CPU          — always measured as the baseline

Missing libraries are reported as {"ok": false, "error": "not installed"} — never as available. Studio reads the
result from <cache>/accel-probe.json (hardware::profile) and the voice / ASR backends use it to choose a device.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time


def _bench(fn, reps=3):
    fn()  # warm-up (kernel compilation / shader cache)
    t = time.perf_counter()
    for _ in range(reps):
        fn()
    return (time.perf_counter() - t) / reps


def probe_torch(size):
    out = {"cuda": {"ok": False}, "mps": {"ok": False}}
    try:
        import torch  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001
        out["cuda"]["error"] = out["mps"]["error"] = f"torch not installed ({type(e).__name__})"
        return out, None
    import numpy as np  # noqa: PLC0415

    rng = np.random.default_rng(0)
    a_np = rng.standard_normal((size, size), dtype=np.float32)
    b_np = rng.standard_normal((size, size), dtype=np.float32)
    ref = a_np @ b_np
    info = {"version": torch.__version__}
    for dev, avail in (("cuda", lambda: torch.cuda.is_available()), ("mps", lambda: getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available())):
        r = out[dev]
        try:
            if not avail():
                r["error"] = "not available" + (f" (built={torch.backends.mps.is_built()})" if dev == "mps" and hasattr(torch.backends, "mps") else "")
                continue
            a = torch.from_numpy(a_np).to(dev)
            b = torch.from_numpy(b_np).to(dev)
            sync = torch.cuda.synchronize if dev == "cuda" else torch.mps.synchronize

            def run():
                c = a @ b
                sync()
                return c

            secs = _bench(run)
            err = float(np.max(np.abs(run().cpu().numpy() - ref)) / (np.max(np.abs(ref)) + 1e-9))
            r.update(ok=err < 1e-3, seconds=round(secs, 5), gflops=round(2 * size**3 / secs / 1e9, 1), relErr=err)
            if dev == "cuda":
                r["device"] = torch.cuda.get_device_name(0)
            if dev == "mps" and hasattr(torch.mps, "driver_allocated_memory"):
                r["driverAllocatedMiB"] = torch.mps.driver_allocated_memory() // 2**20
        except Exception as e:  # noqa: BLE001
            r["error"] = f"{type(e).__name__}: {e}"[:300]
    return out, info


def probe_mlx(size):
    r = {"ok": False}
    try:
        import mlx.core as mx  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001
        r["error"] = f"mlx not installed ({type(e).__name__})"
        return r
    try:
        import numpy as np  # noqa: PLC0415

        r["version"] = getattr(mx, "__version__", "?")
        r["defaultDevice"] = str(mx.default_device())
        if hasattr(mx, "metal") and hasattr(mx.metal, "is_available"):
            r["metal"] = bool(mx.metal.is_available())
            if hasattr(mx.metal, "device_info"):
                di = mx.metal.device_info()
                r["deviceInfo"] = {k: (int(v) if isinstance(v, (int, float)) else str(v)) for k, v in di.items()}
        rng = np.random.default_rng(0)
        a_np = rng.standard_normal((size, size), dtype=np.float32)
        b_np = rng.standard_normal((size, size), dtype=np.float32)
        a, b = mx.array(a_np), mx.array(b_np)

        def run():
            c = mx.matmul(a, b, stream=mx.gpu)
            mx.eval(c)
            return c

        secs = _bench(run)
        ref = a_np @ b_np
        err = float(np.max(np.abs(np.array(run()) - ref)) / (np.max(np.abs(ref)) + 1e-9))
        r.update(ok=bool(r.get("metal", True)) and err < 1e-3, seconds=round(secs, 5), gflops=round(2 * size**3 / secs / 1e9, 1), relErr=err)
    except Exception as e:  # noqa: BLE001
        r["error"] = f"{type(e).__name__}: {e}"[:300]
    return r


def probe_cpu(size):
    import numpy as np  # noqa: PLC0415

    rng = np.random.default_rng(0)
    a = rng.standard_normal((size, size), dtype=np.float32)
    b = rng.standard_normal((size, size), dtype=np.float32)
    secs = _bench(lambda: a @ b)
    return {"ok": True, "seconds": round(secs, 5), "gflops": round(2 * size**3 / secs / 1e9, 1), "numpy": np.__version__}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--size", type=int, default=2048)
    a = ap.parse_args()
    rep = {
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "machine": platform.machine(),
        "macVer": platform.mac_ver()[0] or None,
        "size": a.size,
    }
    try:
        rep["cpu"] = probe_cpu(a.size)
    except Exception as e:  # noqa: BLE001
        rep["cpu"] = {"ok": False, "error": str(e)}
    t, info = probe_torch(a.size)
    rep.update(t)
    rep["torch"] = info
    rep["mlx"] = probe_mlx(a.size)
    text = json.dumps(rep, ensure_ascii=False, indent=2)
    print(text)
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
