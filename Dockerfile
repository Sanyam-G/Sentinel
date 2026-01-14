FROM python:3.11-slim

# Install SSH client so we can tunnel to raserv
RUN apt-get update && apt-get install -y openssh-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy logic
COPY main.py .

# Run the server
CMD ["python", "main.py"]
