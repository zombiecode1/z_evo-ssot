#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# ZombieCoder Transport — Service Runner
# ═══════════════════════════════════════════════════════════════
# 
# ./start.sh          — Kill old + Start all + Open browser
# ./start.sh status   — Check status only
# ./start.sh stop     — Kill all
#
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$SCRIPT_DIR/logs"
PID_DIR="$SCRIPT_DIR/pids"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$LOG_DIR" "$PID_DIR"

# ── Kill old processes on specific ports ────────────────────────

kill_old() {
  local ports=(9999 3333 3001 3000 5000 9999)
  for port in "${ports[@]}"; do
    local pids=$(lsof -ti:$port 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo -e "${YELLOW}[$(date +%H:%M:%S)]${NC} Killing processes on port $port: $pids"
      for pid in $pids; do
        kill $pid 2>/dev/null || true
      done
      sleep 1
      # Force kill if still alive
      for pid in $pids; do
        kill -9 $pid 2>/dev/null || true
      done
    fi
  done
  sleep 1
}

# ── Start a service ────────────────────────────────────────────

start_service() {
  local name=$1
  local cmd=$2
  local port=$3
  local cwd=$4
  local pid_file="$PID_DIR/$name.pid"
  local log_file="$LOG_DIR/$name.log"

  echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} Starting $name on port $port..."
  
  cd "$cwd"
  nohup bash -c "$cmd" > "$log_file" 2>&1 &
  echo $! > "$pid_file"
  
  # Wait and verify
  sleep 3
  if kill -0 $(cat "$pid_file") 2>/dev/null; then
    # Check if port is listening
    if lsof -ti:$port >/dev/null 2>&1; then
      echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $name ${GREEN}OK${NC} (port $port, PID $(cat $pid_file))"
    else
      echo -e "${YELLOW}[$(date +%H:%M:%S)]${NC} $name ${YELLOW}starting${NC} (port $port not yet listening)"
    fi
  else
    echo -e "${RED}[$(date +%H:%M:%S)]${NC} $name ${RED}FAILED${NC} — check $log_file"
  fi
}

# ── Check status ───────────────────────────────────────────────

check_status() {
  echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  ZombieCoder — Service Status${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
  
  local services=("9999:Proxi-API" "3333:WebSocket" "3001:Admin" "3000:Main")
  
  for svc in "${services[@]}"; do
    local port="${svc%%:*}"
    local name="${svc##*:}"
    local pid=$(lsof -ti:$port 2>/dev/null | head -1)
    
    if [ -n "$pid" ]; then
      local latency=$(curl -s -o /dev/null -w "%{time_total}" --connect-timeout 2 "http://localhost:$port" 2>/dev/null || echo "?")
      echo -e "  ${GREEN}●${NC} $name (port $port, PID $pid, ${latency}s)"
    else
      echo -e "  ${RED}✗${NC} $name (port $port, stopped)"
    fi
  done
  
  # Check tunnel
  if pgrep -f "cloudflared" >/dev/null 2>&1; then
    echo -e "  ${GREEN}●${NC} Cloudflare Tunnel (running)"
  else
    echo -e "  ${RED}✗${NC} Cloudflare Tunnel (stopped)"
  fi
  echo ""
}

# ── Main ───────────────────────────────────────────────────────

case "${1:-start}" in
  start)
    echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  ZombieCoder Transport — Starting${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
    
    # Step 1: Kill old processes
    echo ""
    echo -e "${YELLOW}Step 1: Cleaning old processes...${NC}"
    kill_old
    
    # Step 2: Build
    echo ""
    echo -e "${YELLOW}Step 2: Building project...${NC}"
    cd "$PROJECT_DIR"
    npm run build 2>&1 | tail -1
    
    # Step 3: Start services
    echo ""
    echo -e "${YELLOW}Step 3: Starting services...${NC}"
    
    # Adapter Server (status dashboard + streaming)
    start_service "adapter" "node dist/adapter/server.js" 3333 "$PROJECT_DIR"
    
    # Proxi API (main gateway)
    start_service "proxi-api" "node dist/index.js" 9999 "$PROJECT_DIR"
    
    # Step 4: Open browser
    echo ""
    echo -e "${YELLOW}Step 4: Opening browser...${NC}"
    sleep 2
    
    # Try different browser openers
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "http://localhost:3333" 2>/dev/null &
    elif command -v google-chrome >/dev/null 2>&1; then
      google-chrome "http://localhost:3333" 2>/dev/null &
    elif command -v firefox >/dev/null 2>&1; then
      firefox "http://localhost:3333" 2>/dev/null &
    elif command -v sensible-browser >/dev/null 2>&1; then
      sensible-browser "http://localhost:3333" 2>/dev/null &
    else
      echo -e "${YELLOW}Browser not found. Open manually: http://localhost:3333${NC}"
    fi
    
    echo ""
    check_status
    
    echo -e "${BLUE}URLs:${NC}"
    echo -e "  Dashboard: ${GREEN}http://localhost:3333${NC}"
    echo -e "  API:       ${GREEN}http://localhost:9999${NC}"
    echo -e "  Tunnel:    ${GREEN}https://g.smartearningplatformbd.net${NC}"
    echo ""
    ;;
    
  status)
    check_status
    ;;
    
  stop)
    echo -e "${YELLOW}Stopping all services...${NC}"
    kill_old
    
    # Kill tunnel
    pkill -f "cloudflared tunnel" 2>/dev/null || true
    
    echo -e "${GREEN}All services stopped${NC}"
    ;;
    
  restart)
    $0 stop
    sleep 2
    $0 start
    ;;
    
  *)
    echo "Usage: $0 {start|stop|status|restart}"
    exit 1
    ;;
esac
