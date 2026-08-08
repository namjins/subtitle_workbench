#!/usr/bin/env bash
# Works around the GUI-launch PATH problem: an app started from Finder inherits
# only /usr/bin:/bin:/usr/sbin:/sbin, so Homebrew tools (ffmpeg, tesseract) are
# invisible. Prepending /opt/homebrew/bin before exec makes the CLI find them.
# Wired up as the `cli:native` npm script.
set -euo pipefail

export PATH="/opt/homebrew/bin:$PATH"
exec "$@"
