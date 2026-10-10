#!/bin/zsh
set -eu
cd "${0:A:h}"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo '请先安装 Node.js 22 或更新版本。'; exit 1
fi
if [ ! -d node_modules ]; then npm ci --no-audit --no-fund; fi
if [ ! -f data/projects/sanxingdui/project.json ]; then python3 scripts/import_sample.py; fi
if curl --silent --fail http://127.0.0.1:4317/api/health >/dev/null; then
  open http://127.0.0.1:4317; exit 0
fi
(
  for attempt in {1..60}; do
    if curl --silent --fail http://127.0.0.1:4317/api/health >/dev/null; then
      open http://127.0.0.1:4317; break
    fi
    sleep 0.5
  done
) &
exec npm run dev
