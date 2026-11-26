"""TTS 程序的健康監看：心跳、各階段時間上限、停滯時留下證據後結束。

為什麼（2026-11-23）：配音「卡 3 小時」的實際原因是 Studio 在 GPU 驅動重置後停擺、工作從未開始；但配音程序本身也沒有
任何防護——推論若真的卡在 CUDA 呼叫裡，程序會無限期等待，Studio 只看到沒有輸出。這裡提供：

* 心跳：每 30 秒印一行 `♥ 階段 句子 已 N 秒｜RAM｜VRAM`（Studio 的無輸出上限只在整個程序凍結時才會觸發，
  正常但很慢的推論不會被誤判）。
* 階段上限：模型載入、每一句合成、每一句對齊各有上限（可用環境變數調整）。超過時先把所有執行緒的堆疊印出來
  （faulthandler：卡在哪一行一目了然），執行清理（例如停止 GPU 記錄），再以結束碼 4 離開。已完成的句子早已逐句寫檔，
  重新執行只會重做沒完成的句子。
* GpuLogger：用本程序內的執行緒取代 `nvidia-smi -l` 子程序；程序結束（包括被強制結束）時不會留下孤兒 nvidia-smi
  （實測 2026-11-23 留下 3 個，分別已輪詢 GPU 3–5 小時）。

只用標準函式庫（venv 沒有 psutil）。
"""
from __future__ import annotations

import faulthandler
import os
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

STALL_EXIT_CODE = 4


def rss_mib() -> int:
    """本程序常駐記憶體（MiB）；取不到時回傳 0。"""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                            ("PeakPagefileUsage", ctypes.c_size_t)]
            c = PMC()
            c.cb = ctypes.sizeof(PMC)
            psapi = ctypes.WinDLL("psapi")
            k32 = ctypes.WinDLL("kernel32")
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
            if psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(c), c.cb):
                return int(c.WorkingSetSize // 2**20)
            return 0
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") // 2**20
    except Exception:  # noqa: BLE001
        return 0


def torch_vram_mib() -> int | None:
    t = sys.modules.get("torch")
    try:
        if t is not None and t.cuda.is_available() and t.cuda.is_initialized():
            return int(t.cuda.memory_reserved() // 2**20)
    except Exception:  # noqa: BLE001
        pass
    return None


def env_secs(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


class Watchdog:
    """`with wd.phase("合成", lid, limit): ...`；心跳與超時由背景執行緒處理。"""

    def __init__(self, heartbeat: float | None = None, out=None, exit_fn=None):
        self.heartbeat = heartbeat if heartbeat is not None else env_secs("PIKARA_TTS_HEARTBEAT_SEC", 30)
        self.out = out or (lambda s: print(s, flush=True))
        self.exit_fn = exit_fn or os._exit
        self.cleanups: list = []
        self._lock = threading.Lock()
        self._phase: tuple[str, str, float, float] | None = None  # name, detail, started, limit
        self._stop = threading.Event()
        self.fired: str | None = None
        self._t = threading.Thread(target=self._loop, name="tts-watchdog", daemon=True)
        self._t.start()

    @contextmanager
    def phase(self, name: str, detail: str = "", limit: float = 0):
        with self._lock:
            prev = self._phase
            self._phase = (name, detail, time.time(), limit)
        try:
            yield
        finally:
            with self._lock:
                self._phase = prev

    def set(self, name: str, detail: str = "", limit: float = 0):
        """不用 with 的寫法：設定目前階段（覆蓋前一個）。"""
        with self._lock:
            self._phase = (name, detail, time.time(), limit)

    def clear(self):
        with self._lock:
            self._phase = None

    def status(self) -> str:
        with self._lock:
            ph = self._phase
        vram = torch_vram_mib()
        mem = f"RAM {rss_mib()} MiB" + (f"｜VRAM(本程序) {vram} MiB" if vram is not None else "")
        if not ph:
            return f"♥ 待命｜{mem}"
        name, detail, t0, limit = ph
        lim = f"／上限 {limit:.0f} 秒" if limit else ""
        return f"♥ {name} {detail} 已 {time.time() - t0:.0f} 秒{lim}｜{mem}"

    def _loop(self):
        last = time.time()
        while not self._stop.wait(1.0):
            with self._lock:
                ph = self._phase
            if ph and ph[3] and time.time() - ph[2] > ph[3]:
                self._fire(ph)
                return
            if time.time() - last >= self.heartbeat:
                self.out(self.status())
                last = time.time()

    def _fire(self, ph):
        name, detail, t0, limit = ph
        self.fired = f"{name} {detail}".strip()
        self.out(f"[停滯] {name} {detail} 已 {time.time() - t0:.0f} 秒，超過上限 {limit:.0f} 秒；"
                 f"RAM {rss_mib()} MiB。以下是各執行緒目前所在位置（用來判斷卡在哪裡）：")
        try:
            sys.stdout.flush()
            faulthandler.dump_traceback(file=sys.stdout, all_threads=True)
            sys.stdout.flush()
        except Exception:  # noqa: BLE001
            pass
        for fn in self.cleanups:
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass
        self.out(f"[停滯] 結束程序（結束碼 {STALL_EXIT_CODE}）。已完成的句子都已保存；重新執行只會重做未完成的句子。")
        self.exit_fn(STALL_EXIT_CODE)

    def stop(self):
        self._stop.set()


class GpuLogger:
    """每 interval 秒把 nvidia-smi 讀數附加到 CSV（本程序內的執行緒，不留子程序）。沒有 nvidia-smi 時什麼都不做。"""

    FIELDS = "timestamp,memory.used,utilization.gpu,temperature.gpu,power.draw,clocks_throttle_reasons.active"

    def __init__(self, path: Path, interval: float = 5.0):
        self.path, self.interval = Path(path), interval
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._loop, name="gpu-logger", daemon=True)
        self._t.start()

    def _loop(self):
        header = True
        while not self._stop.is_set():
            try:
                r = subprocess.run(["nvidia-smi", f"--query-gpu={self.FIELDS}", "--format=csv" + (",noheader" if not header else "")],
                                   capture_output=True, text=True, timeout=10)
                if r.returncode == 0 and r.stdout.strip():
                    with open(self.path, "a", encoding="utf-8") as f:
                        f.write(r.stdout)
                    header = False
            except FileNotFoundError:
                return  # 沒有 NVIDIA 驅動
            except (OSError, subprocess.SubprocessError):
                pass
            self._stop.wait(self.interval)

    def terminate(self):
        self._stop.set()
