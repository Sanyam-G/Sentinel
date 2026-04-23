# Sentinel

Real-time SSH intrusion dashboard. Streams `journalctl` over an SSH tunnel from a remote server, parses failed login attempts, geolocates attacker IPs against the MaxMind GeoLite2 database, and renders them on a custom d3 SVG world map with live telemetry.

Live at [sentinel.sanyamgarg.com](https://sentinel.sanyamgarg.com).

## Design

Interface is built to a Teenage Engineering + Nothing aesthetic: warm cream background, single red accent, IBM Plex Mono throughout, VT323 dot-matrix numerals for metric values. No glows, no rounded corners, no gradients.

Key UI elements:
- **Custom SVG world map** — d3-geo + `johan/world.geo.json`, equirectangular projection. All countries render dimmed on load; a country "activates" the first time it produces an attack in the current session.
- **Ballistic attack lines** — straight 1px red lines drawn from origin to target in sync with a sharp projectile. Crosshair tick marks at launch, crosshair + filled-square flash at impact.
- **Diagnostic LED row** — 14 squares in the top strip, random one flickers red on every attack.
- **Live sparkline** — 60-second rolling attack-rate mini-histogram next to `LAST_60S`.
- **Numbered TE-style blocks** (01 – 07), each with its section label in red.

## Architecture

1. **Log collection** — container SSHes into the target server and streams `journalctl -u ssh -f`. A key is mounted read-only at `/app/ssh_key`.
2. **Parsing** — Python regex extracts `(invalid user | failed password)` events and pulls the attacker IP and attempted username.
3. **Enrichment** — IPs are geolocated against MaxMind's GeoLite2 City database for country, city, lat/lon.
4. **Storage** — SQLite with a 1-hour retention window; a background thread prunes older rows every 5 minutes.
5. **API** — FastAPI exposes `/api/poll` (incremental attacks since `last_id`) and `/api/stats` (totals, unique IPs, unique countries, last-60-second rate, container uptime).
6. **Frontend** — polls every 1.5 seconds. Live attacks animate on the map; historical backfill loads on page open (last hour of data) without animation.

## Stack

Python · FastAPI · SQLite · d3.js · topojson · Chart.js · Docker · MaxMind GeoLite2

## Run locally

Prerequisites: Docker, SSH key auth to the target server, `GeoLite2-City.mmdb`.

```bash
# Drop GeoLite2-City.mmdb into data/
cp GeoLite2-City.mmdb data/

# Env
cat > .env <<EOF
TARGET_HOST=your.target.host
TARGET_USER=root
EOF

# Adjust docker-compose.yml so the ssh_key volume points at a valid private key
# (default assumes ~/.ssh/id_rsa), then:
docker compose up -d --build
```

Dashboard at `http://localhost:8000`.

## Deploy flow

Production runs on ajstor behind a Cloudflare Tunnel. Frontend-only changes are `rsync -avz static/ ajstor:/home/sammy/data/sentinel/static/` (the container mounts `./static` as a volume, so new files are served live). Backend (`main.py`) changes require `docker compose up -d --build`.

Static asset URLs in `index.html` are versioned (`style.css?v=…`) to bust Cloudflare's edge cache on deploy.

## Files

- `main.py` — log streaming, SQLite layer, FastAPI routes, cleanup loop
- `static/index.html` — dashboard markup
- `static/style.css` — full UI
- `static/script.js` — d3 map, live polling, attack animations, LED + sparkline
- `data/` — SQLite DB + GeoLite2 mmdb (volume-mounted)
- `docker-compose.yml` — container, env, volume mounts
- `Dockerfile` — Python 3.11 slim + openssh-client

## License

MIT
