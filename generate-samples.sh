#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_file=${1:-"$script_dir/samples.js"}
temporary_json=$(mktemp "${TMPDIR:-/tmp}/prsim-samples.XXXXXX")

cleanup() {
  rm -f "$temporary_json"
}
trap cleanup EXIT INT TERM

jq -s '.' "$script_dir"/examples/*.json > "$temporary_json"
sed '1s/^/window.SAMPLES = /; $s/$/;/' "$temporary_json" > "$output_file"
