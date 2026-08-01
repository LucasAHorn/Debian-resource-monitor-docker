const http = require("http");
const os = require("os");
const { readFile } = require("fs/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");

const PORT = 5000;
const execFileAsync = promisify(execFile);

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundTo(value, digits = 2) {
  return Number(toFiniteNumber(value).toFixed(digits));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseSizeToBytes(value) {
  const match = String(value || "").trim().match(/^([0-9]*\.?[0-9]+)\s*([A-Za-z]+)?$/);
  if (!match) return 0;
  const units = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
  return Number(match[1]) * (units[(match[2] || "b").toLowerCase()] || 1);
}

async function readAggregateCpuTimes() {
  const contents = await readFile("/proc/stat", "utf8");
  const line = contents.split("\n").find(item => item.startsWith("cpu "));
  if (!line) throw new Error("Unable to read CPU stats.");
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  return { idle: (fields[3] || 0) + (fields[4] || 0), total: fields.reduce((sum, value) => sum + value, 0) };
}

async function getCpuUsage(windowMs = 1000) {
  const start = await readAggregateCpuTimes();
  await sleep(windowMs);
  const end = await readAggregateCpuTimes();
  const totalDelta = end.total - start.total;
  return totalDelta > 0 ? Math.max(0, Math.min(100, Math.round((1 - (end.idle - start.idle) / totalDelta) * 1000) / 10)) : 0;
}

async function getDiskUsage() {
  const targets = [{ path: "/host-root", label: "/" }, { path: "/srv/fast", label: "/srv/fast" }, { path: "/srv/storage", label: "/srv/storage" }];
  try {
    const { stdout } = await execFileAsync("df", ["-kP", ...targets.map(target => target.path)]);
    return stdout.trim().split("\n").slice(1).map((line, index) => {
      const parts = line.trim().split(/\s+/);
      const target = targets[index];
      if (!target || parts.length < 6) return null;
      const total = Number(parts[1]) * 1024;
      const used = Number(parts[2]) * 1024;
      return { path: target.label, percent_used: toFiniteNumber(parts[4].replace("%", "")), used_gb: roundTo(used / 1e9), total_gb: roundTo(total / 1e9), available_gb: roundTo((Number(parts[3]) * 1024) / 1e9) };
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function readNetworkTotals() {
  const lines = (await readFile("/proc/net/dev", "utf8")).trim().split("\n").slice(2);
  return lines.reduce((totals, line) => {
    const [interfaceName, valuesPart] = line.split(":");
    const values = (valuesPart || "").trim().split(/\s+/);
    if (!interfaceName?.trim() || interfaceName.trim() === "lo" || values.length < 16) return totals;
    const rx = Number(values[0]);
    const tx = Number(values[8]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) return totals;
    totals.interface_count += 1;
    totals.rx_bytes += rx;
    totals.tx_bytes += tx;
    return totals;
  }, { interface_count: 0, rx_bytes: 0, tx_bytes: 0 });
}

async function getNetworkUsage(windowMs = 1000) {
  try {
    const start = await readNetworkTotals();
    await sleep(windowMs);
    const end = await readNetworkTotals();
    const rx = Math.max(0, end.rx_bytes - start.rx_bytes) / (windowMs / 1000);
    const tx = Math.max(0, end.tx_bytes - start.tx_bytes) / (windowMs / 1000);
    return { interface_count: end.interface_count, rx_bytes: end.rx_bytes, tx_bytes: end.tx_bytes, rx_bytes_per_sec: roundTo(rx), tx_bytes_per_sec: roundTo(tx), rx_mbps: roundTo(rx * 8 / 1e6), tx_mbps: roundTo(tx * 8 / 1e6), total_mbps: roundTo((rx + tx) * 8 / 1e6), rx_gb: roundTo(end.rx_bytes / 1e9), tx_gb: roundTo(end.tx_bytes / 1e9) };
  } catch (_) {
    return null;
  }
}

async function getGpuMetrics() {
  try {
    const args = ["--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total", "--format=csv,noheader,nounits"];
    let stdout;
    try {
      ({ stdout } = await execFileAsync("chroot", ["/host-root", "/usr/lib/nvidia/current/nvidia-smi", ...args]));
    } catch (_) {
      ({ stdout } = await execFileAsync("nvidia-smi", args));
    }
    const gpus = stdout.trim().split("\n").filter(Boolean).map(line => {
      const [index, name, gpuUtil, memoryUtil, memoryUsed, memoryTotal] = line.split(",").map(part => part.trim());
      const used = toFiniteNumber(memoryUsed);
      const total = toFiniteNumber(memoryTotal);
      return { index: toFiniteNumber(index), name: name || "GPU", gpu_util_percent: toFiniteNumber(gpuUtil), memory_util_percent: toFiniteNumber(memoryUtil), vram_used_mb: used, vram_total_mb: total, vram_used_gb: roundTo(used / 1024), vram_total_gb: roundTo(total / 1024), vram_used_percent: total > 0 ? Math.round(used / total * 100) : 0 };
    });
    if (!gpus.length) return null;
    const total = gpus.reduce((sum, gpu) => ({ gpu: sum.gpu + gpu.gpu_util_percent, memory: sum.memory + gpu.memory_util_percent, used: sum.used + gpu.vram_used_mb, total: sum.total + gpu.vram_total_mb }), { gpu: 0, memory: 0, used: 0, total: 0 });
    return { count: gpus.length, primary: gpus[0], average_gpu_util_percent: Math.round(total.gpu / gpus.length), average_memory_util_percent: Math.round(total.memory / gpus.length), total_vram_used_gb: roundTo(total.used / 1024), total_vram_total_gb: roundTo(total.total / 1024), gpus };
  } catch (_) {
    return null;
  }
}

async function getContainerStats() {
  try {
    const { stdout } = await execFileAsync("docker", ["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}"]);
    return stdout.trim().split("\n").filter(Boolean).reduce((stats, line) => {
      const [name, cpu, memory, percent] = line.split("|");
      const [used, limit] = (memory || "").split("/").map(item => item.trim());
      const usedBytes = parseSizeToBytes(used);
      const limitBytes = parseSizeToBytes(limit);
      stats[name] = { cpu_percent: toFiniteNumber(cpu?.replace("%", "")), memory_used_bytes: usedBytes, memory_limit_bytes: limitBytes, memory_percent_container: toFiniteNumber(percent?.replace("%", "")), memory_used_gb: roundTo(usedBytes / 1e9), memory_limit_gb: limitBytes ? roundTo(limitBytes / 1e9) : null };
      return stats;
    }, {});
  } catch (_) {
    return {};
  }
}

async function listContainers() {
  const [{ stdout }, stats] = await Promise.all([execFileAsync("docker", ["ps", "-a", "--format", "{{.Names}}|{{.Status}}|{{.State}}"]) , getContainerStats()]);
  return stdout.trim().split("\n").filter(Boolean).map(line => {
    const [name, status, state] = line.split("|");
    return { name, status, state, stats: stats[name] || { cpu_percent: 0, memory_used_bytes: 0, memory_limit_bytes: 0, memory_percent_container: 0, memory_used_gb: 0, memory_limit_gb: null } };
  }).sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function isValidContainerName(name) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(body);
}

function sendNotFound(res) {
  sendJson(res, 404, { error: "not_found", detail: "Endpoint not found." });
}

async function resourceSnapshot() {
  const total = os.totalmem();
  const free = os.freemem();
  const [cpu, disks, network, gpu] = await Promise.all([getCpuUsage(), getDiskUsage(), getNetworkUsage(), getGpuMetrics()]);
  return { ok: true, generated_at: new Date().toISOString(), cpu_percent: cpu, cpu_cores: os.cpus().length || 1, ram_percent: total ? Math.round((total - free) / total * 100) : 0, ram_used_gb: roundTo((total - free) / 1e9), ram_total_gb: roundTo(total / 1e9), ram_used_bytes: total - free, ram_total_bytes: total, disks, gpu, network };
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/resources") {
    try { sendJson(res, 200, await resourceSnapshot()); } catch (error) { sendJson(res, 500, { ok: false, error: "resource_snapshot_failed", generated_at: new Date().toISOString(), detail: error.message }); }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/docker") {
    try { sendJson(res, 200, await listContainers()); } catch (error) { sendJson(res, 503, { error: "docker_ps_failed", detail: error.stderr?.trim() || error.message }); }
    return;
  }

  const detailMatch = url.pathname.match(/^\/api\/docker\/([^/]+)$/);
  const actionMatch = url.pathname.match(/^\/api\/docker\/([^/]+)\/(start|stop|pause|unpause)$/);
  if ((detailMatch || actionMatch) && !isValidContainerName(decodeURIComponent((detailMatch || actionMatch)[1]))) {
    sendJson(res, 400, { error: "invalid_container_name", detail: "Container name contains unsupported characters." });
    return;
  }

  if (req.method === "GET" && detailMatch) {
    const name = decodeURIComponent(detailMatch[1]);
    try {
      const { stdout } = await execFileAsync("docker", ["inspect", name]);
      const [details] = JSON.parse(stdout);
      const logs = await execFileAsync("docker", ["logs", "--tail", "200", name]);
      sendJson(res, 200, { name: details.Name.replace(/^\//, ""), state: { status: details.State.Status, running: details.State.Running, paused: details.State.Paused, exit_code: details.State.ExitCode, started_at: details.State.StartedAt, finished_at: details.State.FinishedAt }, config: { image: details.Config.Image }, network: { ports: details.NetworkSettings.Ports || {} }, logs: logs.stdout });
    } catch (error) { sendJson(res, 500, { error: "docker_detail_failed", detail: error.stderr?.trim() || error.message }); }
    return;
  }

  if (req.method === "POST" && actionMatch) {
    const name = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    try { await execFileAsync("docker", [action, name]); sendJson(res, 200, { ok: true, name, action }); }
    catch (error) { sendJson(res, 500, { error: `docker_${action}_failed`, detail: error.stderr?.trim() || error.stdout?.trim() || error.message }); }
    return;
  }

  sendNotFound(res);
}

http.createServer((req, res) => {
  handleRequest(req, res).catch(error => sendJson(res, 500, { error: "request_failed", detail: error.message }));
}).listen(PORT, "0.0.0.0", () => console.log(`API running on port ${PORT}`));
