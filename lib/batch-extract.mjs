import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { buildMkvExtractPlan, extractMkvTracks, inspectMkv } from "./video-extractor.mjs";

/**
 * Node replacement for tools/extract_english_subs.sh.
 *
 * The shell version could not run on Windows (find/xargs -P/awk), and parsed
 * mkvinfo's English prose, so it silently found no subtitles under a
 * non-English locale and treated a BCP-47-only language element as "und". This
 * reuses the same `mkvmerge -J` JSON path the bridge already uses.
 */
export function selectTracksForLanguages(tracks, languages) {
  if (!languages.length || languages.includes("all")) return tracks;
  const wanted = new Set(languages.map((code) => code.toLowerCase()));
  return tracks.filter((track) => {
    const ietf = String(track.languageIetf ?? "").toLowerCase().split("-")[0];
    return wanted.has(String(track.languageCode).toLowerCase()) || (ietf && wanted.has(ietf));
  });
}

export function parseLanguageList(value) {
  return String(value ?? "eng")
    .split(",")
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
}

async function findVideos(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".mkv")
    .map((entry) => join(directory, entry.name))
    .sort();
}

export async function extractSubtitlesFromDirectory({
  directory,
  languages = ["eng"],
  jobs = 1,
  skipExisting = true,
  onLog = () => {},
} = {}) {
  const root = resolve(directory);
  const videos = await findVideos(root);
  if (!videos.length) {
    onLog(`No .mkv files found in ${root}`);
    return { videos: 0, extracted: [], failures: [] };
  }

  const extracted = [];
  const failures = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < videos.length) {
      const input = videos[nextIndex];
      nextIndex += 1;

      try {
        const { tracks } = await inspectMkv(input);
        const wanted = selectTracksForLanguages(tracks, languages);
        if (!wanted.length) {
          onLog(`No matching subtitle tracks in ${input}`);
          continue;
        }

        // Plan first so already-extracted tracks can be skipped without
        // invoking mkvextract at all.
        const plan = buildMkvExtractPlan(input, wanted, root);
        const pending = plan.filter((item) => !(skipExisting && item.outputs.every(existsSync)));
        if (!pending.length) {
          onLog(`Already extracted: ${input}`);
          continue;
        }

        const result = await extractMkvTracks({
          input,
          tracks: pending.map((item) => item.track),
          outDir: root,
        });
        extracted.push(...result.outputs);
        onLog(`Extracted ${result.outputs.length} file(s) from ${input}`);
      } catch (error) {
        // Report and keep going, but record it: the shell version exited 0
        // even when every track failed.
        failures.push({ input, error: error.message });
        onLog(`FAILED ${input}: ${error.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(jobs, videos.length)) }, () => worker()),
  );

  return { videos: videos.length, extracted, failures };
}
