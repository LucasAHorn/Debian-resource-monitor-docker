const express = require("express");
const cors = require("cors");
const os = require("os");
const { readFile } = require("fs/promises");
const { promisify } = require("util");
const { execFile } = require("child_process");

const app = express();
const execFileAsync = promisify(execFile);

app.use(cors());

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundTo(value, digits = 2) {
  return Number(toFiniteNumber(value).toFixed(digits));
}

function buildResourceSnapshot({ cpu_percent, disks, gpu, network, cpu_cores, ram_used_bytes, ram_total_bytes, ram_percent }) {
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    cpu_percent: toFiniteNumber(cpu_percent),
    cpu_cores: toFiniteNumber(cpu_cores, 1) || 1,
    ram_percent: toFiniteNumber(ram_percent),
    ram_used_gb: roundTo(toFiniteNumber(ram_used_bytes) / 1e9),
    ram_total_gb: roundTo(toFiniteNumber(ram_total_bytes) / 1e9),
    ram_used_bytes: toFiniteNumber(ram_used_bytes),
    ram_total_bytes: toFiniteNumber(ram_total_bytes),
    disks: Array.isArray(disks) ? disks : [],
    gpu: gpu || null,
    network: network || null
  };
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function readAggregateCpuTimes() {
  const contents = await readFile("/proc/stat", "utf8");
  const cpuLine = contents.split("\n").find(line => line.startsWith("cpu "));

  if (!cpuLine) {
    throw new Error("Unable to read CPU stats.");
  }

  const fields = cpuLine.trim().split(/\s+/).slice(1).map(Number);
  const idle = (fields[3] || 0) + (fields[4] || 0);
  const total = fields.reduce((sum, value) => sum + value, 0);

  return { idle, total };
}

async function getCpuUsage(windowMs = 1000) {
  const start = await readAggregateCpuTimes();
  await sleep(windowMs);
  const end = await readAggregateCpuTimes();
  const totalDelta = end.total - start.total;
  const idleDelta = end.idle - start.idle;

  if (totalDelta <= 0) {
    return 0;
  }

  const percent = (1 - idleDelta / totalDelta) * 100;
  return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
}

function formatBytesToGb(bytes) {
  return roundTo(bytes / 1e9);
}

async function execFirstAvailable(commandCandidates, args) {
  let lastError = null;

  for (const command of commandCandidates) {
    try {
      return await execFileAsync(command, args);
    } catch (error) {
      lastError = error;
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw lastError || new Error("No matching command found.");
}

function summarizeExecError(error) {
  if (!error) {
    return "Unknown GPU probe failure.";
  }

  const detail =
    error.stderr?.trim() ||
    error.stdout?.trim() ||
    error.message ||
    "Unknown GPU probe failure.";

  return detail;
}

function parseSizeToBytes(value) {
  const match = String(value).trim().match(/^([0-9]*\.?[0-9]+)\s*([A-Za-z]+)?$/);

  if (!match) {
    return 0;
  }

  const amount = Number(match[1]);
  const unit = (match[2] || "B").toLowerCase();
  const units = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4
  };

  return amount * (units[unit] || 1);
}

async function getDiskUsage() {
  const diskTargets = [
    { path: "/host-root", label: "/" },
    { path: "/srv/fast", label: "/srv/fast" },
    { path: "/srv/storage", label: "/srv/storage" }
  ];

  try {
    const { stdout } = await execFileAsync("df", ["-kP", ...diskTargets.map(target => target.path)]);

    const rows = stdout
      .trim()
      .split("\n")
      .slice(1)
      .map(line => line.trim().split(/\s+/));

    return rows
      .map((parts, index) => {
        const target = diskTargets[index];

        if (!target || parts.length < 6) {
          return null;
        }

        const totalBytes = Number(parts[1]) * 1024;
        const usedBytes = Number(parts[2]) * 1024;
        const availableBytes = Number(parts[3]) * 1024;

        return {
          path: target.label,
          percent_used: toFiniteNumber(String(parts[4]).replace("%", "")),
          used_gb: formatBytesToGb(usedBytes),
          total_gb: formatBytesToGb(totalBytes),
          available_gb: formatBytesToGb(availableBytes)
        };
      })
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

async function readNetworkTotals() {
  const contents = await readFile("/proc/net/dev", "utf8");
  const lines = contents.trim().split("\n").slice(2);

  return lines.reduce((totals, line) => {
    const [interfaceName, valuesPart] = line.split(":");
    const name = (interfaceName || "").trim();
    const values = (valuesPart || "").trim().split(/\s+/);

    if (!name || name === "lo" || values.length < 16) {
      return totals;
    }

    const rxBytes = Number(values[0]);
    const txBytes = Number(values[8]);

    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) {
      return totals;
    }

    totals.interface_count += 1;
    totals.rx_bytes += rxBytes;
    totals.tx_bytes += txBytes;
    return totals;
  }, {
    interface_count: 0,
    rx_bytes: 0,
    tx_bytes: 0
  });
}

async function getNetworkUsage(windowMs = 1000) {
  try {
    const start = await readNetworkTotals();
    await sleep(windowMs);
    const end = await readNetworkTotals();
    const elapsedSeconds = Math.max(1, windowMs / 1000);
    const rxBytesPerSec = Math.max(0, end.rx_bytes - start.rx_bytes) / elapsedSeconds;
    const txBytesPerSec = Math.max(0, end.tx_bytes - start.tx_bytes) / elapsedSeconds;

    return {
      interface_count: end.interface_count,
      rx_bytes: end.rx_bytes,
      tx_bytes: end.tx_bytes,
      rx_bytes_per_sec: roundTo(rxBytesPerSec),
      tx_bytes_per_sec: roundTo(txBytesPerSec),
      rx_mbps: roundTo((rxBytesPerSec * 8) / 1e6),
      tx_mbps: roundTo((txBytesPerSec * 8) / 1e6),
      total_mbps: roundTo(((rxBytesPerSec + txBytesPerSec) * 8) / 1e6),
      rx_gb: roundTo(end.rx_bytes / 1e9),
      tx_gb: roundTo(end.tx_bytes / 1e9)
    };
  } catch (error) {
    return null;
  }
}

async function getGpuMetrics() {
  try {
    const queryArgs = [
      "--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total",
      "--format=csv,noheader,nounits"
    ];

    let stdout = null;

    try {
      ({ stdout } = await execFileAsync("chroot", ["/host-root", "/usr/lib/nvidia/current/nvidia-smi", ...queryArgs]));
    } catch (chrootError) {
      ({ stdout } = await execFirstAvailable([
        "/usr/lib/nvidia/current/nvidia-smi",
        "nvidia-smi",
        "/usr/bin/nvidia-smi",
        "/bin/nvidia-smi"
      ], queryArgs));
    }

    const gpus = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [index, name, gpuUtil, memoryUtil, memoryUsed, memoryTotal] = line
          .split(",")
          .map(part => part.trim());

        const usedMb = toFiniteNumber(memoryUsed);
        const totalMb = toFiniteNumber(memoryTotal);

        return {
          index: toFiniteNumber(index),
          name,
          gpu_util_percent: toFiniteNumber(gpuUtil),
          memory_util_percent: toFiniteNumber(memoryUtil),
          vram_used_mb: usedMb,
          vram_total_mb: totalMb,
          vram_used_gb: roundTo(usedMb / 1024),
          vram_total_gb: roundTo(totalMb / 1024),
          vram_used_percent: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0
        };
      });

    if (!gpus.length) {
      return null;
    }

    const summary = gpus.reduce(
      (acc, gpu) => {
        acc.count += 1;
        acc.gpuUtilTotal += gpu.gpu_util_percent;
        acc.memoryUtilTotal += gpu.memory_util_percent;
        acc.vramUsedMb += gpu.vram_used_mb;
        acc.vramTotalMb += gpu.vram_total_mb;
        return acc;
      },
      {
        count: 0,
        gpuUtilTotal: 0,
        memoryUtilTotal: 0,
        vramUsedMb: 0,
        vramTotalMb: 0
      }
    );

    return {
      count: summary.count,
      primary: gpus[0],
      average_gpu_util_percent: Math.round(summary.gpuUtilTotal / summary.count),
      average_memory_util_percent: Math.round(summary.memoryUtilTotal / summary.count),
      total_vram_used_gb: roundTo(summary.vramUsedMb / 1024),
      total_vram_total_gb: roundTo(summary.vramTotalMb / 1024),
      gpus
    };
  } catch (error) {
    return {
      error: "gpu_probe_failed",
      detail: summarizeExecError(error)
    };
  }
}

async function getContainerStats() {
  try {
    const { stdout } = await execFileAsync("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}"
    ]);

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .reduce((statsByName, line) => {
        const [name, cpuPerc, memUsage, memPerc] = line.split("|");
        const [memoryUsed, memoryLimit] = (memUsage || "").split("/").map(part => part.trim());
        const usedBytes = parseSizeToBytes(memoryUsed);
        const limitBytes = parseSizeToBytes(memoryLimit);

        statsByName[name] = {
          cpu_percent: toFiniteNumber(String(cpuPerc).replace("%", "")),
          memory_used_bytes: usedBytes,
          memory_limit_bytes: limitBytes,
          memory_percent_container: toFiniteNumber(String(memPerc).replace("%", "")),
          memory_used_gb: roundTo(usedBytes / 1e9),
          memory_limit_gb: limitBytes > 0 ? roundTo(limitBytes / 1e9) : null
        };

        return statsByName;
      }, {});
  } catch (error) {
    return {};
  }
}

async function listContainers() {
  const [psResult, statsByName] = await Promise.all([
    execFileAsync("docker", ["ps", "-a", "--format", "{{.Names}}|{{.Status}}|{{.State}}"]),
    getContainerStats()
  ]);

  return psResult.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [name, status, state] = line.split("|");
      const containerStats = statsByName[name] || {
        cpu_percent: 0,
        memory_used_bytes: 0,
        memory_limit_bytes: 0,
        memory_percent_container: 0,
        memory_used_gb: 0,
        memory_limit_gb: null
      };

      return {
        name,
        status,
        state,
        stats: containerStats
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function isValidContainerName(name) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}

function inspectContainer(name, callback) {
  execFile("docker", ["inspect", name], (err, stdout, stderr) => {
    if (err) {
      callback({
        status: 500,
        payload: {
          error: "docker_inspect_failed",
          detail: stderr.trim() || err.message
        }
      });
      return;
    }

    try {
      const [details] = JSON.parse(stdout);

      callback({
        status: 200,
        payload: {
          name: details.Name.replace(/^\//, ""),
          state: {
            status: details.State.Status,
            running: details.State.Running,
            paused: details.State.Paused,
            exit_code: details.State.ExitCode,
            started_at: details.State.StartedAt,
            finished_at: details.State.FinishedAt
          },
          config: {
            image: details.Config.Image
          },
          network: {
            ports: details.NetworkSettings.Ports || {}
          }
        }
      });
    } catch (parseError) {
      callback({
        status: 500,
        payload: {
          error: "docker_inspect_parse_failed",
          detail: parseError.message
        }
      });
    }
  });
}

function getContainerLogs(name, callback) {
  execFile("docker", ["logs", "--tail", "200", name], (err, stdout, stderr) => {
    if (err) {
      callback({
        status: 500,
        payload: {
          error: "docker_logs_failed",
          detail: stderr.trim() || err.message
        }
      });
      return;
    }

    callback({
      status: 200,
      payload: {
        logs: stdout
      }
    });
  });
}

app.get("/api/resources", (req, res) => {
  (async () => {
    const mem = os.totalmem();
    const free = os.freemem();
    const cpuCores = os.cpus().length;

    const [cpu_percent, disks, network, gpu] = await Promise.all([
      getCpuUsage(),
      getDiskUsage(),
      getNetworkUsage(),
      getGpuMetrics()
    ]);

    res.json(
      buildResourceSnapshot({
        cpu_percent,
        cpu_cores: cpuCores,
        ram_percent: mem > 0 ? Math.round(((mem - free) / mem) * 100) : 0,
        ram_used_bytes: mem - free,
        ram_total_bytes: mem,
        disks,
        gpu,
        network
      })
    );
  })().catch(error => {
    res.status(500).json({
      ok: false,
      error: "resource_snapshot_failed",
      generated_at: new Date().toISOString(),
      detail: error.message
    });
  });
});

app.get("/api/docker", (req, res) => {
  listContainers()
    .then(containers => {
      res.json(containers);
    })
    .catch(error => {
      res.status(500).json({
        error: "docker_ps_failed",
        detail: error.stderr?.trim() || error.message
      });
    });
});

app.get("/api/docker/:name", (req, res) => {
  const { name } = req.params;

  if (!isValidContainerName(name)) {
    res.status(400).json({
      error: "invalid_container_name",
      detail: "Container name contains unsupported characters."
    });
    return;
  }

  inspectContainer(name, inspectResult => {
    if (inspectResult.status !== 200) {
      res.status(inspectResult.status).json(inspectResult.payload);
      return;
    }

    getContainerLogs(name, logsResult => {
      if (logsResult.status !== 200) {
        res.status(logsResult.status).json(logsResult.payload);
        return;
      }

      res.json({
        ...inspectResult.payload,
        logs: logsResult.payload.logs
      });
    });
  });
});

app.post("/api/docker/:name/:action", (req, res) => {
  const { name, action } = req.params;

  if (!isValidContainerName(name)) {
    res.status(400).json({
      error: "invalid_container_name",
      detail: "Container name contains unsupported characters."
    });
    return;
  }

  if (!["start", "stop", "pause", "unpause"].includes(action)) {
    res.status(400).json({
      error: "invalid_action",
      detail: "Action must be start, stop, pause, or unpause."
    });
    return;
  }

  execFile("docker", [action, name], (err, stdout, stderr) => {
    if (err) {
      res.status(500).json({
        error: `docker_${action}_failed`,
        detail: stderr.trim() || stdout.trim() || err.message
      });
      return;
    }

    res.json({
      ok: true,
      name,
      action
    });
  });
});

app.listen(5000, "0.0.0.0", () => {
  console.log("API running on port 5000");
});
