# 全機 GPU 租約（與 Studio 的 ResourceScheduler 共用；studio/app/src-tauri/src/gpulock.rs）。
# 測試、Benchmark、UI 截圖都要先取得「全域租約」：取得後 Studio 不會再開始新的 GPU 工作，並等 Studio 正在跑的 GPU 工作結束。
# 由這個程序啟動的 Studio（--cli run-queue）透過 PIKARA_GPU_LOCK_OWNER 知道租約屬於祖先程序，照常執行。
#
#   py -3.11 scripts/gpu_lock.py --who "UI 截圖" [--timeout 3600] -- <指令 …>     取得租約後執行指令，結束時釋放
#   from gpu_lock import gpu_lease; with gpu_lease("Benchmark"): ...
import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

if os.name == "nt":
    GENERIC_RW = 0x80000000 | 0x40000000
    OPEN_ALWAYS = 4
    INVALID = ctypes.c_void_p(-1).value
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.restype = ctypes.c_void_p
    k32.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    k32.CloseHandle.argtypes = [ctypes.c_void_p]
else:
    import fcntl  # macOS / Linux: flock — the same lock Rust's File::try_lock takes in gpulock.rs


def lock_dir() -> Path:
    """Windows %ProgramData%\\PikaraScience; macOS ~/Library/Caches/PikaraScience; Linux $XDG_CACHE_HOME/PikaraScience."""
    if os.name == "nt":
        return Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "PikaraScience"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "PikaraScience"
    return Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache")) / "PikaraScience"


def lock_path() -> Path:
    if os.environ.get("PIKARA_GPU_LOCK"):
        return Path(os.environ["PIKARA_GPU_LOCK"])
    return lock_dir() / "gpu.lock"


def _open_excl(p: Path):
    p.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        h = k32.CreateFileW(str(p), GENERIC_RW, 0, None, OPEN_ALWAYS, 0x80, None)  # share mode 0 = exclusive
        return None if h in (None, INVALID) else h
    fd = os.open(str(p), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def _close(h) -> None:
    if os.name == "nt":
        k32.CloseHandle(h)
    else:
        os.close(h)  # closing the descriptor releases the flock


def _free(p: Path) -> bool:
    h = _open_excl(p)
    if h is None:
        return False
    _close(h)
    return True


def holder(p: Path) -> str:
    try:
        j = json.loads(Path(str(p) + ".json").read_text(encoding="utf-8"))
        return f"{j.get('who')}（PID {j.get('pid')}，自 {j.get('since')} 起）"
    except Exception:  # noqa: BLE001
        return "另一個程式"


@contextmanager
def gpu_lease(who: str, timeout: float = 3600, poll: float = 2.0, log=print):
    """Whole-machine GPU lease: exclusive global lock, then wait until no Studio GPU job holds an adapter lease."""
    if os.environ.get("PIKARA_GPU_LOCK_OWNER"):  # already inside a lease holder
        yield
        return
    p = lock_path()
    t0 = time.time()
    h = None
    told = False
    while h is None:
        h = _open_excl(p)
        if h is None:
            if not told:
                log(f"[GPU 租約] 等待：{holder(p)}")
                told = True
            if time.time() - t0 > timeout:
                raise TimeoutError(f"等待 GPU 租約超過 {timeout} 秒：{holder(p)}")
            time.sleep(poll)
    info = Path(str(p) + ".json")
    info.write_text(json.dumps({"who": who, "pid": os.getpid(), "since": time.strftime("%Y-%m-%dT%H:%M:%S")}, ensure_ascii=False), encoding="utf-8")
    prev = os.environ.get("PIKARA_GPU_LOCK_OWNER")
    os.environ["PIKARA_GPU_LOCK_OWNER"] = str(os.getpid())
    try:
        # Studio jobs already running keep their adapter leases until they finish
        while True:
            busy = [q for q in p.parent.glob("gpu-*.lock") if not _free(q)]
            if not busy:
                break
            if time.time() - t0 > timeout:
                raise TimeoutError("等待 Studio GPU 工作結束逾時：" + "、".join(holder(q) for q in busy))
            log("[GPU 租約] 等待 Studio 工作釋放 GPU：" + "、".join(holder(q) for q in busy))
            time.sleep(poll * 5)
        log(f"[GPU 租約] 取得：{who}")
        yield
    finally:
        if prev is None:
            os.environ.pop("PIKARA_GPU_LOCK_OWNER", None)
        else:
            os.environ["PIKARA_GPU_LOCK_OWNER"] = prev
        info.unlink(missing_ok=True)
        _close(h)
        log(f"[GPU 租約] 釋放：{who}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--who", required=True)
    ap.add_argument("--timeout", type=float, default=3600)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not cmd:
        print(json.dumps({"path": str(lock_path()), "free": _free(lock_path()), "holder": holder(lock_path())}, ensure_ascii=False))
        return 0
    with gpu_lease(a.who, a.timeout):
        return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(main())
