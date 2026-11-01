#!/usr/bin/env bash
# =============================================================================
# Craft Suite & Boson Unified Pipeline — One-Click Lifecycle Orchestrator
# Penggunaan:
#   ./pipeline.sh start   -> Menyalakan seluruh stack (DB, Gateway, Frontends, Ingress)
#   ./pipeline.sh stop    -> Mematikan seluruh stack secara bersih
#   ./pipeline.sh status  -> Menampilkan status kesehatan seluruh port & ingress routes
# =============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBSITE_DIR="/var/home/fazdev/.gemini/antigravity/scratch/craft-apps/artcraft-website"
SERVICES_DIR="/var/home/fazdev/artcraft-services"
TEMPS_DIR="/var/home/fazdev/temps"

case "$1" in
  start)
    echo -e "${BLUE}============================================================${NC}"
    echo -e "${BLUE}🚀 Memulai Craft Suite & Boson Unified Pipeline...${NC}"
    echo -e "${BLUE}============================================================${NC}"

    # 1. Start Docker Containers (Postgres, Auth, Gateway, LiteLLM, Temps-DB)
    echo -e "${YELLOW}[1/5] Memastikan Database & Core Backend Container berjalan...${NC}"
    cd "$ROOT_DIR"
    docker compose up -d

    # 2. Start Temps PaaS (Ingress & OTel)
    echo -e "${YELLOW}[2/5] Memastikan Temps Ingress & Observability (:8080) aktif...${NC}"
    if ! ss -tulpn | grep -q ":8080 "; then
      if [ -f "$HOME/.temps-dev/slot-0.env" ]; then
        source "$HOME/.temps-dev/slot-0.env"
        cd "$TEMPS_ROOT/crates/temps-cli"
        RUST_BACKTRACE=1 TEMPS_LOG_FORMAT=compact TEMPS_DATA_DIR="$TEMPS_DATA_DIR" TEMPS_ADMIN_EMAIL="$TEMPS_ADMIN_EMAIL" TEMPS_ADMIN_PASSWORD_FILE="$TEMPS_ADMIN_PASSWORD_FILE" TEMPS_DISABLE_HTTPS_REDIRECT=true TEMPS_TELEMETRY=0 TEMPS_ALLOW_INSECURE_SANDBOX_NETWORKING=1 nohup "$TEMPS_ROOT/target/fast/temps" serve \
          --disable-https-redirect \
          --database-url="$TEMPS_DATABASE_URL" \
          --address=0.0.0.0:$TEMPS_HTTP_PORT \
          --tls-address=127.0.0.1:$TEMPS_TLS_PORT \
          --console-address=0.0.0.0:$TEMPS_CONSOLE_PORT \
          --log-level=info > /tmp/temps-serve.log 2>&1 &
        sleep 2
      fi
    fi

    # 3. Start Socat OTel Bridge
    if ! ss -tulpn | grep -q ":18080 "; then
      nohup socat TCP-LISTEN:18080,fork,reuseaddr TCP:127.0.0.1:8080 > /dev/null 2>&1 &
    fi

    # 4. Start Swagger Docs (:8989)
    echo -e "${YELLOW}[3/5] Memastikan OpenAPI Swagger Docs (:8989) aktif...${NC}"
    if ! ss -tulpn | grep -q ":8989 "; then
      cd "$SERVICES_DIR"
      nohup ./target/debug/docs > /tmp/craft-docs.log 2>&1 &
    fi

    # 5. Start ArtCraft Studio WebApp (:4201)
    echo -e "${YELLOW}[4/5] Memastikan Studio WebApp (:4201) aktif...${NC}"
    if ! ss -tulpn | grep -q ":4201 "; then
      cd "$SERVICES_DIR/frontend/apps/artcraft-webapp"
      nohup npx vite --port 4201 --host 0.0.0.0 > /tmp/craft-webapp.log 2>&1 &
    fi

    # 6. Start ArtCraft Website (:3000)
    echo -e "${YELLOW}[5/5] Memastikan ArtCraft Website Portal (:3000) aktif...${NC}"
    if ! ss -tulpn | grep -q ":3000 "; then
      cd "$WEBSITE_DIR"
      nohup npm run start -- -p 3000 > /tmp/craft-website.log 2>&1 &
    fi

    echo -e "\n${GREEN}✅ Seluruh layanan pipeline telah aktif sempurna!${NC}"
    echo -e "${CYAN}------------------------------------------------------------${NC}"
    echo -e " 🛡️  TEMPS UNIFIED INGRESS (Port 8080 Routing):"
    echo -e "  • Website Portal : ${GREEN}http://artcraft-website-production.localho.st:8080${NC}"
    echo -e "  • Studio WebApp  : ${GREEN}http://artcraft-studio-production.localho.st:8080${NC}"
    echo -e "  • Boson Gateway  : ${GREEN}http://boson-pipeline-production.localho.st:8080${NC}"
    echo -e "  • Swagger Docs   : ${GREEN}http://swagger-docs-production.localho.st:8080${NC}"
    echo -e "  • Temps Console  : ${GREEN}http://localhost:8081${NC}"
    echo -e "  • Supabase Studio: ${GREEN}http://localhost:3001${NC}"
    echo -e "  • LiteLLM Proxy  : ${GREEN}http://localhost:4000${NC}"
    echo -e "${CYAN}------------------------------------------------------------${NC}"
    ;;

  stop)
    echo -e "${RED}🛑 Menghentikan seluruh background dev server & pipeline...${NC}"
    pkill -f "next-server" || true
    pkill -f "vite" || true
    pkill -f "target/debug/docs" || true
    pkill -f "target/fast/temps" || true
    pkill -f "socat TCP-LISTEN:18080" || true
    cd "$ROOT_DIR"
    docker compose stop
    echo -e "${GREEN}✅ Semua proses dan container telah dihentikan secara aman.${NC}"
    ;;

  status)
    echo -e "${BLUE}============================================================${NC}"
    echo -e "${BLUE}📊 Status Kesehatan Port & Layanan Pipeline:${NC}"
    echo -e "${BLUE}============================================================${NC}"
    declare -A services=(
      ["3000"]="ArtCraft Website Portal"
      ["4201"]="ArtCraft Studio WebApp"
      ["8080"]="Temps Ingress & Telemetry"
      ["8081"]="Temps Admin Console"
      ["8088"]="Boson API Gateway"
      ["8989"]="OpenAPI Swagger Docs"
      ["4000"]="LiteLLM Model Router"
      ["3001"]="Supabase Studio Dashboard"
      ["5432"]="PostgreSQL Core Database"
      ["5434"]="TimescaleDB Telemetry"
    )

    for port in 3000 4201 8080 8081 8088 8989 4000 3001 5432 5434; do
      name="${services[$port]}"
      if ss -tulpn | grep -q ":$port "; then
        printf "  %-30s (Port :%-5s) -> ${GREEN}ONLINE (Active)${NC}\n" "$name" "$port"
      else
        printf "  %-30s (Port :%-5s) -> ${RED}OFFLINE${NC}\n" "$name" "$port"
      fi
    done

    echo -e "\n${MAGENTA}🌐 Validasi Rute Ingress Reverse Proxy (Port 8080):${NC}"
    for domain in \
      "artcraft-website-production.localho.st:8080" \
      "artcraft-studio-production.localho.st:8080" \
      "boson-pipeline-production.localho.st:8080/health" \
      "swagger-docs-production.localho.st:8080"; do
      status_code=$(curl -s -o /dev/null -w "%{http_code}" "http://$domain" || echo "ERR")
      if [ "$status_code" = "200" ]; then
        printf "  http://%-50s -> ${GREEN}HTTP %s OK${NC}\n" "$domain" "$status_code"
      else
        printf "  http://%-50s -> ${RED}HTTP %s${NC}\n" "$domain" "$status_code"
      fi
    done
    echo -e "${BLUE}============================================================${NC}"
    ;;

  test)
    echo -e "${CYAN}🧪 Menjalankan End-to-End Pipeline Integration Test...${NC}"
    node "$ROOT_DIR/tests/test-pipeline-e2e.mjs"
    ;;

  *)
    echo "Penggunaan: $0 {start|stop|status|test}"
    exit 1
    ;;
esac
