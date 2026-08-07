#!/usr/bin/env bash
# Parallel image subtitle extraction using mkvinfo + mkvextract.
# DVD VobSub tracks are written as .sub + .idx pairs; Blu-ray/UHD PGS tracks
# are written as .sup files.
#
# Usage:
#   ./tools/extract_english_subs.sh
#   JOBS=4 ./tools/extract_english_subs.sh
#   ./tools/extract_english_subs.sh -j 4
#   ./tools/extract_english_subs.sh --languages eng,spa
#   LANGUAGES=eng,spa ./tools/extract_english_subs.sh
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

detect_safe_jobs() {
  local cores=""
  if command -v getconf >/dev/null 2>&1; then
    cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  fi
  if [ -z "$cores" ] && command -v sysctl >/dev/null 2>&1; then
    cores="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  fi
  if [ -z "$cores" ] && command -v nproc >/dev/null 2>&1; then
    cores="$(nproc 2>/dev/null || true)"
  fi
  case "$cores" in (*[!0-9]*|'') cores=4;; esac
  local jobs=$(( cores - 1 ))
  [ "$jobs" -lt 1 ] && jobs=1
  [ "$jobs" -gt 8 ] && jobs=8
  printf "%s" "$jobs"
}

JOBS="${JOBS:-auto}"
if [ "$JOBS" = "auto" ]; then
  JOBS="$(detect_safe_jobs)"
fi
SUBTITLE_LANGUAGES="${LANGUAGES:-${SUBTITLE_LANGUAGES:-eng}}"

while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    -j|--jobs)
      [ -n "${2:-}" ] || break
      JOBS="$2"
      if [ "$JOBS" = "auto" ]; then
        JOBS="$(detect_safe_jobs)"
      fi
      shift 2 || true
      ;;
    -l|--languages)
      [ -n "${2:-}" ] || break
      SUBTITLE_LANGUAGES="$2"
      shift 2 || true
      ;;
    --all-languages)
      SUBTITLE_LANGUAGES="all"
      shift || true
      ;;
    --worker)
      break
      ;;
    *)
      shift || true
      ;;
  esac
done

export SUBTITLE_LANGUAGES

process_one_file() {
  file="$1"
  pid="$$"
  filename="${file##*/}"
  base="${filename%.mkv}"
  base="${base%.MKV}"

  echo "[$(timestamp)] [PID $pid] START  \"$filename\""

  tracks="$(
    mkvinfo "$file" | awk '
      function language_wanted(lang, parts, count, i) {
        if (wanted == "all" || wanted == "*") return 1
        count = split(wanted, parts, /,/)
        for (i = 1; i <= count; i++) {
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", parts[i])
          if (parts[i] == lang) return 1
        }
        return 0
      }
      BEGIN {
        wanted=ENVIRON["SUBTITLE_LANGUAGES"]
        if (wanted == "") wanted="eng"
        is_sub=0; id=""; codec=""; lang="und"
      }
      /^\| \+ (A )?Track$/ {
        if (is_sub && language_wanted(lang) && id != "") print id "\t" codec "\t" lang;
        is_sub=0; id=""; codec=""; lang="und";
        next
      }
      /Track type: subtitles/ { is_sub=1 }
      /Language:/ {
        s=$0
        sub(/.*Language: /,"",s)
        sub(/[^A-Za-z0-9_-].*/,"",s)
        lang=s
      }
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
        if (is_sub && language_wanted(lang) && id != "") print id "\t" codec "\t" lang;
      }
    '
  )"

  if [ -z "$tracks" ]; then
    echo "[$(timestamp)] [PID $pid] INFO   No matching subtitle languages ($SUBTITLE_LANGUAGES) found in \"$filename\"."
    echo "[$(timestamp)] [PID $pid] DONE   \"$filename\""
    return 0
  fi

  count=0
  specs=()
  any_to_extract=0

  while IFS="$(printf '\t')" read -r track_id codec_id track_lang; do
    [ -z "$track_id" ] && continue
    # DVB subtitles are intentionally skipped: they are not PGS, and writing
    # them to a .sup produces a file the OCR path silently converts to an
    # empty SRT.
    case "$codec_id" in
      S_VOBSUB*) ext="sub" ;;
      S_HDMV/PGS*) ext="sup" ;;
      *)
        echo "[$(timestamp)] [PID $pid] SKIP   track $track_id $track_lang ($codec_id) is not a supported image subtitle format"
        continue
        ;;
    esac

    stem="$base"
    if [ "$SUBTITLE_LANGUAGES" != "eng" ] || [ "${track_lang:-eng}" != "eng" ]; then
      stem="${base}-${track_lang:-und}"
    fi

    if [ "$count" -eq 0 ]; then
      outname="${stem}.${ext}"
    else
      outname="${stem}${count}.${ext}"
    fi

    if [ -e "$outname" ] || { [ "$ext" = "sub" ] && [ -e "${outname%.sub}.idx" ]; }; then
      echo "[$(timestamp)] [PID $pid] SKIP   \"$outname\" (already exists)"
    else
      if [ "$ext" = "sub" ]; then
        echo "[$(timestamp)] [PID $pid] QUEUE  track $track_id $track_lang ($codec_id) -> \"${outname%.sub}.sub\" + \"${outname%.sub}.idx\""
      else
        echo "[$(timestamp)] [PID $pid] QUEUE  track $track_id $track_lang ($codec_id) -> \"$outname\""
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
echo "[INFO] Extracting subtitle languages: $SUBTITLE_LANGUAGES."
echo "[INFO] Starting at $(date)."

find . -maxdepth 1 -type f \( -name "*.mkv" -o -name "*.MKV" \) -print0 \
  | xargs -0 -I {} -P "$JOBS" bash "$0" --worker "{}"

launch_end=$(date +%s || echo 0)
elapsed=$(( launch_end - launch_start ))
echo "[INFO] Finished at  $(date)."
echo "[INFO] Total runtime: $(fmt_secs "$elapsed")"
