# Local Resource Monitor

## Status

 This is a small Docker Compose resource monitor. nginx serves the static
 dashboard on port 8080 and proxies `/api/` requests to the Node API on port
 5000. The API reports host CPU, memory, disks, network traffic, optional GPU
 metrics, and Docker container status/actions. GPU metrics are optional: a
 host without NVIDIA hardware must still be able to run the API and render
 the rest of the dashboard.

 The API is intentionally dependency-free at runtime. `api/server.js` uses
 Node's built-in modules and invokes the Docker CLI when it is available. The
 existing package metadata and lockfile are historical; the service should
 start with Node directly and must not require npm to install packages.

## Layout

 - `html/index.html` — single-page dashboard, including styles and browser
   refresh/render logic.
 - `api/server.js` — HTTP API and host/Docker metric collection.
 - `docker-compose.yml` — nginx and API containers, host/Docker socket mounts,
   and API startup configuration.
 - `nginx/default.conf` — static-file serving and `/api/` reverse proxy.
 - `api/package.json`, `api/package-lock.json` — retained metadata only; they
   are not required to start the API.

## Operational expectations

 - Missing NVIDIA tools or hardware is a normal degraded state. GPU fields
   should be null/unavailable while CPU, memory, disk, and network data remain
   usable.
 - A missing Docker daemon/CLI or malformed API response is also a degraded
   state. The browser should show an actionable status message and keep the
   rest of the page usable.
 - Keep Docker container names and action parameters validated before invoking
   Docker commands.
