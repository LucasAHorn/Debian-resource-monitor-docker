#!/usr/bin/env python3
"""Dependency-free HTTP API for the resource dashboard."""

import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse


PORT = 5000
CONTAINER_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")


def number(value, fallback=0):
    try:
        parsed = float(value)
        return parsed if parsed == parsed and abs(parsed) != float("inf") else fallback
    except (TypeError, ValueError):
        return fallback


def rounded(value, digits=2):
    return round(number(value), digits)


def parse_size(value):
    match = re.match(r"^([0-9]*\.?[0-9]+)\s*([A-Za-z]+)?$", str(value or "").strip())
    if not match:
        return 0
    units = {"b": 1, "kb": 1e3, "mb": 1e6, "gb": 1e9, "tb": 1e12,
             "kib": 1024, "mib": 1024 ** 2, "gib": 1024 ** 3, "tib": 1024 ** 4}
    return float(match.group(1)) * units.get((match.group(2) or "b").lower(), 1)


def run_command(command):
    return subprocess.run(command, capture_output=True, text=True, check=True)


def cpu_times():
    with open("/proc/stat", encoding="utf-8") as source:
        line = next((item for item in source if item.startswith("cpu ")), None)
    if not line:
        raise RuntimeError("Unable to read CPU stats.")
    fields = [float(value) for value in line.split()[1:]]
    return (fields[3] if len(fields) > 3 else 0) + (fields[4] if len(fields) > 4 else 0), sum(fields)


def cpu_usage(window=1):
    start = cpu_times()
    time.sleep(window)
    end = cpu_times()
    total_delta = end[1] - start[1]
    return rounded(max(0, min(100, (1 - (end[0] - start[0]) / total_delta) * 100)), 1) if total_delta > 0 else 0


def disk_usage():
    targets = [("/host-root", "/"), ("/srv/fast", "/srv/fast"), ("/srv/storage", "/srv/storage")]
    try:
        output = run_command(["df", "-kP", *(path for path, _ in targets)]).stdout
        result = []
        for line, (_, label) in zip(output.strip().splitlines()[1:], targets):
            parts = line.split()
            if len(parts) < 6:
                continue
            total, used, available = (int(parts[index]) * 1024 for index in (1, 2, 3))
            result.append({"path": label, "percent_used": number(parts[4].rstrip("%")),
                           "used_gb": rounded(used / 1e9), "total_gb": rounded(total / 1e9),
                           "available_gb": rounded(available / 1e9)})
        return result
    except (OSError, subprocess.CalledProcessError, ValueError):
        return []


def network_totals():
    totals = {"interface_count": 0, "rx_bytes": 0, "tx_bytes": 0}
    with open("/proc/net/dev", encoding="utf-8") as source:
        for line in source.read().strip().splitlines()[2:]:
            interface, _, values = line.partition(":")
            fields = values.split()
            if not interface.strip() or interface.strip() == "lo" or len(fields) < 16:
                continue
            try:
                totals["interface_count"] += 1
                totals["rx_bytes"] += int(fields[0])
                totals["tx_bytes"] += int(fields[8])
            except ValueError:
                continue
    return totals


def network_usage(window=1):
    try:
        start = network_totals()
        time.sleep(window)
        end = network_totals()
        rx = max(0, end["rx_bytes"] - start["rx_bytes"]) / window
        tx = max(0, end["tx_bytes"] - start["tx_bytes"]) / window
        return {**end, "rx_bytes_per_sec": rounded(rx), "tx_bytes_per_sec": rounded(tx),
                "rx_mbps": rounded(rx * 8 / 1e6), "tx_mbps": rounded(tx * 8 / 1e6),
                "total_mbps": rounded((rx + tx) * 8 / 1e6),
                "rx_gb": rounded(end["rx_bytes"] / 1e9), "tx_gb": rounded(end["tx_bytes"] / 1e9)}
    except (OSError, ValueError):
        return None


def gpu_metrics():
    args = ["--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total",
            "--format=csv,noheader,nounits"]
    try:
        try:
            output = run_command(["chroot", "/host-root", "/usr/lib/nvidia/current/nvidia-smi", *args]).stdout
        except (OSError, subprocess.CalledProcessError):
            output = run_command(["nvidia-smi", *args]).stdout
        gpus = []
        for line in output.strip().splitlines():
            index, name, gpu_util, memory_util, memory_used, memory_total = [part.strip() for part in line.split(",")]
            used, total = number(memory_used), number(memory_total)
            gpus.append({"index": number(index), "name": name or "GPU", "gpu_util_percent": number(gpu_util),
                         "memory_util_percent": number(memory_util), "vram_used_mb": used, "vram_total_mb": total,
                         "vram_used_gb": rounded(used / 1024), "vram_total_gb": rounded(total / 1024),
                         "vram_used_percent": round(used / total * 100) if total else 0})
        if not gpus:
            return None
        total = {key: sum(gpu[key] for gpu in gpus) for key in ("gpu_util_percent", "memory_util_percent", "vram_used_mb", "vram_total_mb")}
        return {"count": len(gpus), "primary": gpus[0], "average_gpu_util_percent": round(total["gpu_util_percent"] / len(gpus)),
                "average_memory_util_percent": round(total["memory_util_percent"] / len(gpus)),
                "total_vram_used_gb": rounded(total["vram_used_mb"] / 1024), "total_vram_total_gb": rounded(total["vram_total_mb"] / 1024), "gpus": gpus}
    except (OSError, subprocess.CalledProcessError, ValueError):
        return None


def container_stats():
    try:
        output = run_command(["docker", "stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}"]).stdout
        stats = {}
        for line in output.strip().splitlines():
            name, cpu, memory, percent = line.split("|")
            used, _, limit = memory.partition("/")
            used_bytes, limit_bytes = parse_size(used.strip()), parse_size(limit.strip())
            stats[name] = {"cpu_percent": number(cpu.rstrip("%")), "memory_used_bytes": used_bytes,
                           "memory_limit_bytes": limit_bytes, "memory_percent_container": number(percent.rstrip("%")),
                           "memory_used_gb": rounded(used_bytes / 1e9), "memory_limit_gb": rounded(limit_bytes / 1e9) if limit_bytes else None}
        return stats
    except (OSError, subprocess.CalledProcessError, ValueError):
        return {}


def list_containers():
    output = run_command(["docker", "ps", "-a", "--format", "{{.Names}}|{{.Status}}|{{.State}}"]).stdout
    stats = container_stats()
    default_stats = {"cpu_percent": 0, "memory_used_bytes": 0, "memory_limit_bytes": 0,
                     "memory_percent_container": 0, "memory_used_gb": 0, "memory_limit_gb": None}
    containers = []
    for line in output.strip().splitlines():
        name, status, state = line.split("|")
        containers.append({"name": name, "status": status, "state": state, "stats": stats.get(name, default_stats)})
    return sorted(containers, key=lambda item: item["name"].lower())


def resource_snapshot():
    total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    free = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_AVPHYS_PAGES")
    return {"ok": True, "generated_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "cpu_percent": cpu_usage(), "cpu_cores": os.cpu_count() or 1,
            "ram_percent": round((total - free) / total * 100) if total else 0,
            "ram_used_gb": rounded((total - free) / 1e9), "ram_total_gb": rounded(total / 1e9),
            "ram_used_bytes": total - free, "ram_total_bytes": total,
            "disks": disk_usage(), "gpu": gpu_metrics(), "network": network_usage()}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/resources":
                self.send_json(200, resource_snapshot())
            elif path == "/api/docker":
                self.send_json(200, list_containers())
            else:
                self.detail(path)
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or str(error)).strip()
            self.send_json(503 if path == "/api/docker" else 500, {"error": "docker_command_failed", "detail": detail})
        except Exception as error:
            self.send_json(500, {"error": "request_failed", "detail": str(error)})

    def detail(self, path):
        match = re.fullmatch(r"/api/docker/([^/]+)", path)
        if not match:
            self.send_json(404, {"error": "not_found", "detail": "Endpoint not found."})
            return
        name = unquote(match.group(1))
        if not CONTAINER_NAME.fullmatch(name):
            self.send_json(400, {"error": "invalid_container_name", "detail": "Container name contains unsupported characters."})
            return
        details = json.loads(run_command(["docker", "inspect", name]).stdout)[0]
        logs = run_command(["docker", "logs", "--tail", "200", name]).stdout
        state = details["State"]
        self.send_json(200, {"name": details["Name"].lstrip("/"),
                             "state": {"status": state["Status"], "running": state["Running"], "paused": state["Paused"], "exit_code": state["ExitCode"], "started_at": state["StartedAt"], "finished_at": state["FinishedAt"]},
                             "config": {"image": details["Config"]["Image"]}, "network": {"ports": details["NetworkSettings"].get("Ports") or {}}, "logs": logs})

    def do_POST(self):
        match = re.fullmatch(r"/api/docker/([^/]+)/(start|stop|pause|unpause)", urlparse(self.path).path)
        if not match:
            self.send_json(404, {"error": "not_found", "detail": "Endpoint not found."})
            return
        name, action = unquote(match.group(1)), match.group(2)
        if not CONTAINER_NAME.fullmatch(name):
            self.send_json(400, {"error": "invalid_container_name", "detail": "Container name contains unsupported characters."})
            return
        try:
            run_command(["docker", action, name])
            self.send_json(200, {"ok": True, "name": name, "action": action})
        except subprocess.CalledProcessError as error:
            self.send_json(500, {"error": f"docker_{action}_failed", "detail": (error.stderr or error.stdout or str(error)).strip()})

    def log_message(self, *_):
        return


if __name__ == "__main__":
    print(f"API running on port {PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
