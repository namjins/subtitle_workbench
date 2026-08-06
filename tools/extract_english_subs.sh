#!/usr/bin/env bash
# Parallel English image subtitle extraction using mkvinfo + mkvextract.
# DVD VobSub tracks are written as .sub + .idx pairs; Blu-ray/UHD PGS tracks
# are written as .sup files.
#
# Usage:
#   JOBS=4 ./tools/extract_english_subs.sh
#   ./tools/extract_english_subs.sh -j 4
#
# Requirements: MKVToolNix (mkvinfo, mkvextract)

set -u

timestamp() { date "+%H:%M:%S"; }

fmt_secs() {
  local total=${1:-0}
  case "$total" in (*[!0-9]*|'') total=0;; esac
  local h=$(( total / 3600 ))
  local m=$(( (total % 3600) / 60 ))
  local s=$(( total % 60 ))
  printf "%d:%02d:%02d" "$h" "$m" "$s"
}

JOBS="${JOBS:-2}"
if [ "${1:-}" = "-j" ] && [ -n "${2:-}" ]; then
  JOBS="$2"
  shift 2 || true
fi

process_one_file() {
  file="$1"
  pid="$$"
  filename="${file##*/}"
  base="${filename%.mkv}"
  base="${base%.MKV}"

  echo "[$(timestamp)] [PID $pid] START  \"$filename\""

  tracks="$(
    mkvinfo "$file" | awk '
      BEGIN { is_sub=0; is_eng=0; id=""; codec="" }
      /^\| \+ (A )?Track$/ {
        if (is_sub && is_eng && id != "") print id "\t" codec;
        is_sub=0; is_eng=0; id=""; codec="";
        next
      }
      /Track type: subtitles/ { is_sub=1 }
      /Language: eng/ { is_eng=1 }
      /Codec ID:/ {
        s=$0
        sub(/.*Codec ID: /,"",s)
        codec=s
      }
      /Track number:/ {
        if ($0 ~ /track ID for mkvmerge & mkvextract:/) {
          s=$0
          sub(/.*track ID for mkvmerge & mkvextract: /,"",s)
          sub(/[^0-9].*/,"",s)
          id=s
        }
      }
      END {
        if (is_sub && is_eng && id != "") print id "\t" codec;
      }
    '
  )"

  if [ -z "$tracks" ]; then
    echo "[$(timestamp)] [PID $pid] INFO   No English subtitles found in \"$filename\"."
    echo "[$(timestamp)] [PID $pid] DONE   \"$filename\""
    return 0
  fi

  count=0
  specs=()
  any_to_extract=0

  while IFS="$(printf '\t')" read -r track_id codec_id; do
    [ -z "$track_id" ] && continue
    ext="sup"
    case "$codec_id" in
      S_VOBSUB*) ext="sub" ;;
      S_HDMV/PGS*|S_DVBSUB*) ext="sup" ;;
      *) ext="sup" ;;
    esac

    if [ "$count" -eq 0 ]; then
      outname="${base}.${ext}"
    else
      outname="${base}${count}.${ext}"
    fi

    if [ -e "$outname" ] || { [ "$ext" = "sub" ] && [ -e "${outname%.sub}.idx" ]; }; then
      echo "[$(timestamp)] [PID $pid] SKIP   \"$outname\" (already exists)"
    else
      if [ "$ext" = "sub" ]; then
        echo "[$(timestamp)] [PID $pid] QUEUE  track $track_id ($codec_id) -> \"${outname%.sub}.sub\" + \"${outname%.sub}.idx\""
      else
        echo "[$(timestamp)] [PID $pid] QUEUE  track $track_id ($codec_id) -> \"$outname\""
      fi
      specs+=("${track_id}:${outname}")
      any_to_extract=1
    fi
    count=$((count + 1))
  done <<< "$tracks"

  if [ "$any_to_extract" -eq 0 ]; then
    echo "[$(timestamp)] [PID $pid] INFO   Nothing to extract for \"$filename\"."
    echo "[$(timestamp)] [PID $pid] DONE   \"$filename\""
    return 0
  fi

  echo "[$(timestamp)] [PID $pid] EXTRACT ${#specs[@]} track(s) from \"$filename\"..."
  mkvextract tracks "$file" "${specs[@]}"
  rc=$?

  if [ "$rc" -ne 0 ]; then
    echo "[$(timestamp)] [PID $pid] ERROR  mkvextract failed with code $rc for \"$filename\""
  else
    echo "[$(timestamp)] [PID $pid] OK     Extracted ${#specs[@]} track(s) for \"$filename\""
  fi
  echo "[$(timestamp)] [PID $pid] DONE   \"$filename\""
  return "$rc"
}

if [ "${1:-}" = "--worker" ] && [ -n "${2:-}" ]; then
  process_one_file "$2"
  exit $?
fi

launch_start=$(date +%s)
echo "[INFO] Using JOBS=$JOBS (per-file parallelism)."
echo "[INFO] Starting at $(date)."

find . -maxdepth 1 -type f \( -name "*.mkv" -o -name "*.MKV" \) -print0 \
  | xargs -0 -I {} -P "$JOBS" bash "$0" --worker "{}"

launch_end=$(date +%s || echo 0)
elapsed=$(( launch_end - launch_start ))
echo "[INFO] Finished at  $(date)."
echo "[INFO] Total runtime: $(fmt_secs "$elapsed")"
