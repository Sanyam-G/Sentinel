import sqlite3
import time
import random
import os
import geoip2.database
from datetime import datetime
from zoneinfo import ZoneInfo

# --- Configuration ---
DB_PATH = "/data/sentinel.db"
GEOIP_PATH = "/data/GeoLite2-City.mmdb"
TIMEZONE = ZoneInfo("America/New_York")

# --- DATA SOURCES ---
# We use these as "Base Subnets" to generate variants
IPS_HEAVY = [
    "165.245.132.116", "45.148.10.121", "134.199.194.140",
    "92.118.39.95", "45.135.232.92", "46.62.139.157"
]

IPS_SWARM = [
    "190.158.6.183", "164.90.207.133", "80.94.92.186", "2.57.121.112",
    "213.209.159.159", "187.108.193.162", "193.46.255.7", "45.140.17.124",
    "193.46.255.33", "91.202.233.33", "142.93.140.203", "47.237.114.130",
    "185.196.8.123", "141.98.11.11", "194.38.20.50", "103.151.123.101", 
    "5.188.62.15", "185.156.173.14", "45.95.169.245", "103.145.226.98"
]

USERS_HIGH = ["root", "admin", "user"] 
USERS_MED = ["guest", "ubuntu", "test", "oracle", "postgres", "deploy", "git", "jenkins", "docker", "hadoop", "ftpuser"]
USERS_LOW = ["pi", "debian", "sol", "node", "minima", "roamware", "asterisk", "godfrey", "dmdba", "palworld", "cozmo", "gitlab-runner", "support"]

def mutate_ip(ip):
    """Changes the last octet of an IP to create a unique variant in the same subnet."""
    parts = ip.split('.')
    # Randomize the last number (0-255)
    parts[3] = str(random.randint(1, 255))
    return ".".join(parts)

def get_weighted_ip():
    # Pick a base IP
    if random.random() < 0.5:
        base_ip = random.choice(IPS_HEAVY)
    else:
        base_ip = random.choice(IPS_SWARM)
    
    # 50% Chance to mutate it (creates a NEW unique IP)
    # 50% Chance to keep it (simulates repeat attacker)
    if random.random() < 0.5:
        return mutate_ip(base_ip)
    else:
        return base_ip

def get_weighted_user():
    roll = random.randint(1, 100)
    if roll <= 60: return random.choice(USERS_HIGH)
    elif roll <= 90: return random.choice(USERS_MED)
    else: return random.choice(USERS_LOW)

def get_geo_data(reader, ip):
    try:
        response = reader.city(ip)
        return {
            "country": response.country.name or "Unknown",
            "city": response.city.name or "Unknown",
            "lat": response.location.latitude,
            "lon": response.location.longitude
        }
    except Exception:
        return {"country": "Unknown", "city": "Unknown", "lat": 0.0, "lon": 0.0}

def inject_attack():
    print(f"[*] Sentinel Traffic Generator Running...")
    print(f"[*] Logic: 2.0s Pulse | 20% Hit Rate | IP Mutation Active")
    
    try:
        geo_reader = geoip2.database.Reader(GEOIP_PATH)
    except Exception as e:
        print(f"[!] Critical: Could not load GeoIP DB at {GEOIP_PATH}")
        return

    while True:
        try:
            # 1. Pulse Check (20% chance every 2.0s)
            if random.random() < 0.20:
                
                ip = get_weighted_ip()
                user = get_weighted_user()
                geo = get_geo_data(geo_reader, ip)
                now_ts = datetime.now(TIMEZONE).isoformat()

                with sqlite3.connect(DB_PATH, timeout=20) as conn:
                    c = conn.cursor()
                    c.execute(
                        """INSERT INTO attacks 
                           (timestamp, ip, user, country, city, lat, lon) 
                           VALUES (?, ?, ?, ?, ?, ?, ?)""",
                        (now_ts, ip, user, geo['country'], geo['city'], geo['lat'], geo['lon'])
                    )
                    conn.commit()

                print(f"[+] Injected: {user}@{ip} from {geo['country']}")
            
            # 2. Heartbeat Sleep
            time.sleep(2.0)

        except Exception as e:
            print(f"[!] Error: {e}")
            time.sleep(1)

if __name__ == "__main__":
    inject_attack()
