# Sentinel

Sentinel is a security monitoring dashboard that visualizes SSH authentication attempts in real-time. It connects to a remote server via SSH, tails the system logs, and geolocates incoming IP addresses to display attack vectors on a live map.

## Architecture

1. **Log Collection**: The application establishes a secure SSH tunnel to the target server and streams `journalctl` (systemd) logs.
2. **Parsing**: A Python backend parses the stream for failed login attempts and invalid user errors.
3. **Enrichment**: IP addresses are cross-referenced with the MaxMind GeoLite2 database to determine the origin city and country.
4. **Storage**: Events are stored in a local SQLite database with a 1-hour retention policy.
5. **Visualization**: A FastAPI endpoint serves the data to a frontend dashboard built with Leaflet.js.

## Prerequisites

- Docker and Docker Compose
- SSH access to the target server (key-based authentication)
- MaxMind GeoLite2 City database (`.mmdb`)

## Configuration

1. **Database Setup**
   Place your `GeoLite2-City.mmdb` file inside the `data/` directory.

2. **Environment Variables**
   Create a `.env` file in the root directory:
   ```bash
   TARGET_HOST=192.0.2.1
   TARGET_USER=root
   ```

3. **SSH Key**
   Ensure the `docker-compose.yml` volume mapping points to a valid SSH private key on your host machine that has access to the target server.

## Usage

Build and run the container:

```bash
docker-compose up -d --build
```

The dashboard will be available at `http://localhost:8000`.

## Project Structure

- `main.py`: Backend logic for log streaming, parsing, and API endpoints.
- `static/`: Frontend assets (HTML, CSS, JS).
- `data/`: Volume mount for the SQLite database and GeoIP binary.

## License

MIT

