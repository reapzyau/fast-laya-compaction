#!/usr/bin/env bash
# Builds demo/LayaDemo/main.swift into demo/LayaDemo/build/LayaDemo.app and launches it.
# A native macOS animation of fast-laya-compaction inside a Claude Code-style
# terminal, meant to be screen recorded. Press space in the app to replay.
set -euo pipefail

cd "$(dirname "$0")"
app=build/LayaDemo.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp Info.plist "$app/Contents/"
swiftc -O -parse-as-library \
  -target "$(uname -m)-apple-macos14.0" \
  -framework AppKit -framework SwiftUI \
  main.swift -o "$app/Contents/MacOS/LayaDemo"
codesign --force --sign - "$app" >/dev/null 2>&1 || true

if [[ "${1:-}" != "--no-launch" ]]; then
  open "$app"
fi
