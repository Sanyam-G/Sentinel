import subprocess
import sqlite3
import re
import os
import threading
import time
import geoip2.database
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

TARGET_HOST = os.getenv("TARGET_HOST", "raserv")
TARGET_USER = os.getenv("TARGET_USER", "root")
DB_PATH = os.getenv("DB_PATH", "/data/sentinel.db")
GEOIP_PATH = os.getenv("GEOIP_PATH", "/data/GeoLite2-City.mmdb")
DATA_RETENTION_HOURS = 1
TIMEZONE = ZoneInfo("America/New_York")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

geo_reader = None


def get_now():
    return datetime.now(TIMEZONE)


def init_geo():
    global geo_reader
    if os.path.exists(GEOIP_PATH):
        geo_reader = geoip2.database.Reader(GEOIP_PATH)
        print(f"[*] GeoIP database loaded from {GEOIP_PATH}")
    else:
        print(f"[!] WARNING: GeoIP database not found at {GEOIP_PATH}")


def get_geo_from_ip(ip):
    if not geo_reader:
        return {"country": None, "city": None, "lat": None, "lon": None}
    try:
        geo = geo_reader.city(ip)
        return {
            "country": geo.country.name,
            "city": geo.city.name,
            "lat": geo.location.latitude,
            "lon": geo.location.longitude
        }
    except Exception:
        return {"country": None, "city": None, "lat": None, "lon": None}


def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS attacks 
                 (id INTEGER PRIMARY KEY AUTOINCREMENT, 
                  timestamp TEXT, 
                  ip TEXT, 
                  user TEXT, 
                  country TEXT, 
                  city TEXT, 
                  lat REAL, 
                  lon REAL)''')
    c.execute('CREATE INDEX IF NOT EXISTS idx_timestamp ON attacks(timestamp)')
    conn.commit()
    conn.close()


def cleanup_old_data():
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        cutoff = (get_now() - timedelta(hours=DATA_RETENTION_HOURS)).isoformat()
        c.execute("DELETE FROM attacks WHERE timestamp < ?", (cutoff,))
        deleted = c.rowcount
        conn.commit()
        conn.close()
        if deleted > 0:
            print(f"[*] Cleanup: Removed {deleted} old records")
    except Exception as e:
        print(f"[!] Cleanup error: {e}")


def maintenance_loop():
    while True:
        time.sleep(300)  # Every 5 minutes
        cleanup_old_data()


def monitor_logs():
    print(f"[*] Connecting to {TARGET_USER}@{TARGET_HOST}...")
    
    while True:
        try:
            cmd = [
                "ssh", 
                "-o", "StrictHostKeyChecking=no",
                "-o", "ServerAliveInterval=60",
                "-o", "ServerAliveCountMax=3",
                "-i", "/app/ssh_key",
                f"{TARGET_USER}@{TARGET_HOST}", 
                "journalctl -u ssh -f -n 0"
            ]
            
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            print(f"[*] Connected, monitoring SSH logs...")
            
            log_pattern = re.compile(
                r"Invalid user ([\w\.-]+) from ([\d\.]+)|"
                r"Failed password for (?:invalid user )?([\w\.-]+) from ([\d\.]+)"
            )

            while True:
                line = process.stdout.readline()
                if not line:
                    print("[!] Connection lost, reconnecting...")
                    break
                
                text = line.decode('utf-8', errors='ignore').strip()
                match = log_pattern.search(text)
                
                if match:
                    groups = match.groups()
                    user = groups[0] or groups[2]
                    ip = groups[1] or groups[3]
                    geo = get_geo_from_ip(ip)
                    
                    try:
                        conn = sqlite3.connect(DB_PATH)
                        c = conn.cursor()
                        c.execute(
                            "INSERT INTO attacks (timestamp, ip, user, country, city, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (get_now().isoformat(), ip, user, 
                             geo["country"], geo["city"], geo["lat"], geo["lon"])
                        )
                        conn.commit()
                        conn.close()
                        print(f"[+] {user}@{ip} from {geo['city']}, {geo['country']}")
                    except Exception as e:
                        print(f"[!] DB error: {e}")
            
            process.terminate()
        except Exception as e:
            print(f"[!] Monitor error: {e}")
        
        time.sleep(10)


@app.on_event("startup")
def startup():
    init_geo()
    init_db()
    cleanup_old_data()
    threading.Thread(target=monitor_logs, daemon=True).start()
    threading.Thread(target=maintenance_loop, daemon=True).start()
    print("[*] Sentinel started")


@app.get("/api/poll")
def poll_data(last_id: int = 0):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    now = get_now()
    
    if last_id == 0:
        c.execute("SELECT * FROM attacks ORDER BY id ASC")
    else:
        c.execute("SELECT * FROM attacks WHERE id > ? ORDER BY id ASC", (last_id,))
    
    rows = c.fetchall()
    data = []
    
    for row in rows:
        attack = dict(row)
        try:
            attack_time = datetime.fromisoformat(attack['timestamp'])
            if attack_time.tzinfo is None:
                attack_time = attack_time.replace(tzinfo=TIMEZONE)
            seconds_ago = int((now - attack_time).total_seconds())
            attack['seconds_ago'] = max(0, seconds_ago)
        except:
            attack['seconds_ago'] = 0
        data.append(attack)
    
    max_id = last_id
    if data:
        max_id = data[-1]['id']
    elif last_id == 0:
        c.execute("SELECT MAX(id) FROM attacks")
        result = c.fetchone()[0]
        if result:
            max_id = result
    
    conn.close()
    
    return {
        "attacks": data, 
        "last_id": max_id,
        "is_historical": last_id == 0
    }


@app.get("/api/stats")
def get_stats():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    now = get_now()
    
    c.execute("SELECT COUNT(*) FROM attacks")
    total = c.fetchone()[0]
    
    c.execute("SELECT COUNT(DISTINCT ip) FROM attacks")
    unique_ips = c.fetchone()[0]
    
    c.execute("SELECT COUNT(DISTINCT country) FROM attacks WHERE country IS NOT NULL")
    unique_countries = c.fetchone()[0]
    
    # Count attacks in last 60 seconds
    sixty_seconds_ago = (now - timedelta(seconds=60)).isoformat()
    c.execute("SELECT COUNT(*) FROM attacks WHERE timestamp > ?", (sixty_seconds_ago,))
    last_60 = c.fetchone()[0]
    
    conn.close()
    
    return {
        "total": total,
        "unique_ips": unique_ips,
        "unique_countries": unique_countries,
        "last_60_seconds": last_60
    }


if not os.path.exists("static"):
    os.makedirs("static")
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
