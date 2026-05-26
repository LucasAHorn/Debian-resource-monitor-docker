const express = require("express");
const os = require("os");
const cors = require("cors");
const { exec, execFile } = require("child_process");

const app = express();

app.use(cors()); // 👈 THIS FIXES YOUR ERROR

function getCpuUsage() {
  const cpus = os.cpus();

  let idle = 0;
  let total = 0;

  cpus.forEach(cpu => {
    for (type in cpu.times) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  });

  return Math.round((1 - idle / total) * 100);
}

function formatBytesToGb(bytes) {
  return (bytes / 1e9).toFixed(2);
}

function getDiskUsage(callback) {
  const diskTargets = [
    { path: "/host-root", label: "/" },
    { path: "/srv/fast", label: "/srv/fast" },
    { path: "/srv/storage", label: "/srv/storage" }
  ];

  const diskCommand = `df -kP ${diskTargets.map(target => target.path).join(" ")}`;

  exec(diskCommand, (err, stdout) => {
    if (err) {
      callback([]);
      return;
    }

    const rows = stdout
      .trim()
      .split("\n")
      .slice(1)
      .map(line => line.trim().split(/\s+/));

    const disks = rows
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

    callback(disks);
  });
}

function listContainers(callback) {
  exec("docker ps -a --format '{{.Names}}|{{.Status}}|{{.State}}'", (err, stdout, stderr) => {
    if (err) {
      callback({
        status: 500,
        payload: {
          error: "docker_ps_failed",
          detail: stderr.trim() || err.message
        }
      });
      return;
    }

    const containers = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [name, status, state] = line.split("|");
        return { name, status, state };
      });

    callback({ status: 200, payload: containers });
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
  const mem = os.totalmem();
  const free = os.freemem();

  getDiskUsage(disks => {
    res.json({
      cpu_percent: getCpuUsage(),
      ram_percent: Math.round(((mem - free) / mem) * 100),
      ram_used_gb: ((mem - free) / 1e9).toFixed(2),
      ram_total_gb: (mem / 1e9).toFixed(2),
      disks
    });
  });
});

app.get("/api/docker", (req, res) => {
  listContainers(result => {
    res.status(result.status).json(result.payload);
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
