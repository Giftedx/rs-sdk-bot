#!/usr/bin/env bash
# Re-create vendor/ with shallow clones of every upstream project we study.
set -euo pipefail
cd "$(dirname "$0")/../vendor" 2>/dev/null || { mkdir -p "$(dirname "$0")/../vendor"; cd "$(dirname "$0")/../vendor"; }
repos=(
  "MaxBittker/rs-sdk rs-sdk"
  "MaxBittker/runebench runebench"
  "MaxBittker/rs-world rs-world"
  "MaxBittker/rsmod-pathfinder rsmod-pathfinder"
  "laude-institute/harbor harbor"
  "laude-institute/terminal-bench terminal-bench"
  "LostCityRS/Engine-TS lostcity-engine 289"
  "LostCityRS/Content lostcity-content 289"
  "LostCityRS/Client-TS lostcity-client 289"
  "LostCityRS/Server lostcity-server"
  "LostCityRS/RuneScriptTS lostcity-runescript"
  "LostCityRS/Markets lostcity-markets"
  "Skyvern-AI/jevscape jevscape"
  "samheutmaker/lumbridge-ai lumbridge-ai"
  "dennisdev/rs-map-viewer rs-map-viewer"
  "chsami/Microbot microbot"
  "Skretzo/shortest-path shortest-path"
  "Zoinkwiz/quest-helper quest-helper"
  "jrr97/runescape-ai jrr97-runescape-ai"
)
for entry in "${repos[@]}"; do
  read -r repo dir branch <<<"$entry"
  if [ -d "$dir/.git" ]; then git -C "$dir" pull --ff-only -q && echo "updated $dir"
  else git clone -q -c core.autocrlf=false --depth 20 ${branch:+-b "$branch"} "https://github.com/$repo.git" "$dir" && echo "cloned $dir"; fi
done
