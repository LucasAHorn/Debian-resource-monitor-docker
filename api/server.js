const express = require("express");
const cors = require("cors");
const os = require("os");
const { readFile } = require("fs/promises");
const { promisify } = require("util");
const { execFile } = require("child_process");

const app = express();
const execFileAsync = promisify(execFile);

app.use(cors());

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

async function getCpuUsage(windowMs = 500) {
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
  return (bytes / 1e9).toFixed(2);
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
          percent_used: parts[4],
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

async function getGpuMetrics() {
  try {
    const { stdout } = await execFirstAvailable(["nvidia-smi", "/usr/bin/nvidia-smi", "/bin/nvidia-smi"], [
      "--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total",
      "--format=csv,noheader,nounits"
    ]);

    const gpus = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [index, name, gpuUtil, memoryUtil, memoryUsed, memoryTotal] = line
          .split(",")
          .map(part => part.trim());

        const usedMb = parseNumber(memoryUsed);
        const totalMb = parseNumber(memoryTotal);

        return {
          index: parseNumber(index),
          name,
          gpu_util_percent: parseNumber(gpuUtil),
          memory_util_percent: parseNumber(memoryUtil),
          vram_used_mb: usedMb,
          vram_total_mb: totalMb,
          vram_used_gb: (usedMb / 1024).toFixed(2),
          vram_total_gb: (totalMb / 1024).toFixed(2),
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
      total_vram_used_gb: (summary.vramUsedMb / 1024).toFixed(2),
      total_vram_total_gb: (summary.vramTotalMb / 1024).toFixed(2),
      gpus
    };
  } catch (error) {
    return null;
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
          cpu_percent: parseNumber(String(cpuPerc).replace("%", "")),
          memory_used_bytes: usedBytes,
          memory_limit_bytes: limitBytes,
          memory_percent_container: parseNumber(String(memPerc).replace("%", "")),
          memory_used_gb: (usedBytes / 1e9).toFixed(2),
          memory_limit_gb: limitBytes > 0 ? (limitBytes / 1e9).toFixed(2) : null
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
        memory_used_gb: "0.00",
        memory_limit_gb: null
      };

      return {
        name,
        status,
        state,
        stats: containerStats
      };
    });
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

    const [cpu_percent, disks, gpu] = await Promise.all([
      getCpuUsage(),
      getDiskUsage(),
      getGpuMetrics()
    ]);

    res.json({
      cpu_percent,
      cpu_cores: cpuCores,
      ram_percent: Math.round(((mem - free) / mem) * 100),
      ram_used_gb: ((mem - free) / 1e9).toFixed(2),
      ram_total_gb: (mem / 1e9).toFixed(2),
      ram_used_bytes: mem - free,
      ram_total_bytes: mem,
      disks,
      gpu
    });
  })().catch(error => {
    res.status(500).json({
      error: "resource_snapshot_failed",
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
