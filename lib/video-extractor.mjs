import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

// Single source of truth for what this tool claims to extract. The bridge
// derives its request allowlist from this set so the two cannot drift apart.
//
// S_DVBSUB is deliberately absent. DVB subtitles are not HDMV/PGS, but they
// were extracted to a .sup and then handed to a PGS-only parser, which found
// no PG segments, wrote an empty file and reported success. Claiming no
// support is honest; claiming support and emitting an empty SRT is not.
export const subtitleCodecs = new Set(["S_VOBSUB", "S_HDMV/PGS"]);

export function subtitleFormat(codec = "") {
  if (codec.startsWith("S_VOBSUB")) return "sub + idx";
  return "sup";
}

export function subtitleExtension(codec = "") {
  return subtitleFormat(codec) === "sub + idx" ? "sub" : "sup";
}

export function parseMkvSubtitleTracks(info) {
  // stemIndex is the per-suffix running counter that names outputs. Assigned
  // here, over the full track list, so the output stem is a pure function of
  // (input, track) — extracting a subset used to renumber from 0, which made a
  // partial re-run write track B's content over track A's file.
  const stemCounters = new Map();
  return (info.tracks ?? [])
    .filter((track) => track.type === "subtitles")
    .filter((track) => subtitleCodecs.has(codecId(track)))
    .map((track, index) => {
      const languageCode = track.properties?.language ?? "und";
      const languageIetf = track.properties?.language_ietf;
      const codec = codecId(track);
      const forcedTrack = Boolean(track.properties?.forced_track);
      const suffixKey = stemSuffix({ languageCode, forcedTrack });
      const stemIndex = stemCounters.get(suffixKey) ?? 0;
      stemCounters.set(suffixKey, stemIndex + 1);
      return {
        id: String(track.id),
        trackId: track.id,
        label: `${languageLabel(languageCode)} (${languageCode})${forcedTrack ? " forced" : ""}`,
        languageCode,
        language: languageLabel(languageCode),
        languageIetf,
        codec,
        format: subtitleFormat(codec),
        defaultTrack: Boolean(track.properties?.default_track),
        forcedTrack,
        index,
        stemIndex,
      };
    });
}

function codecId(track) {
  return track.properties?.codec_id ?? track.codec ?? "";
}

function stemSuffix(track) {
  const suffixes = [];
  if (track.languageCode && track.languageCode !== "eng") suffixes.push(track.languageCode);
  if (track.forcedTrack) suffixes.push("forced");
  return suffixes.length ? `-${suffixes.join("-")}` : "";
}

export function outputStem(input, outputIndex, track) {
  const name = basename(input, extname(input)) || "subtitles";
  const suffix = stemSuffix(track);
  // Prefer the track's own per-suffix counter over the positional index: the
  // positional form renumbered whenever a subset was extracted, so re-running
  // with one track pending collapsed its name onto a sibling's and overwrote
  // it. The fallback keeps hand-built track lists (tests, external callers)
  // working unchanged.
  const stem = track.stemIndex ?? outputIndex;
  return stem === 0 ? `${name}${suffix}` : `${name}${stem}${suffix}`;
}

export function buildMkvExtractPlan(input, tracks, outDir) {
  const plan = tracks.map((track, outputIndex) => {
    const extension = subtitleExtension(track.codec);
    const output = join(outDir, `${outputStem(input, outputIndex, track)}.${extension}`);
    const outputs = extension === "sub"
      ? [output, output.replace(/\.sub$/iu, ".idx")]
      : [output];
    return {
      track,
      output,
      outputs,
      spec: `${track.trackId}:${output}`,
    };
  });
  // Two tracks resolving to the same file means one silently overwrites the
  // other — the exact data loss stemIndex exists to prevent. stemIndex arrives
  // over the network on the bridge path, so this must stay a hard error, not
  // an assumption.
  const allOutputs = plan.flatMap((item) => item.outputs);
  if (new Set(allOutputs).size !== allOutputs.length) {
    throw new Error("Extraction plan resolves two tracks to the same output file.");
  }
  return plan;
}

/**
 * Async on purpose: these used to be spawnSync, which blocked the bridge's
 * event loop for the whole of a multi-GB extraction. Every other request —
 * including in-flight OCR progress streams and /health — stalled until it
 * finished, and an abort handler could not run at all.
 */
function runTool(command, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killedForSize = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        killedForSize = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      // Bounded so a chatty tool cannot grow this without limit.
      if (stderr.length < 1024 * 1024) stderr += chunk;
    });
    child.on("error", (error) => reject(new Error(`${command} failed: ${error.message}`)));
    child.on("close", (status) => {
      if (killedForSize) {
        reject(new Error(`${command} produced more output than expected.`));
        return;
      }
      if (status !== 0) {
        reject(new Error(stderr.trim() || `${command} exited with ${status}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

export async function inspectMkv(input) {
  // resolve() before spawning, matching extractMkvTracks: mkvmerge reads a
  // leading `@` as an option file, so a raw network-supplied path would let
  // the caller choose the tool's entire option set.
  const stdout = await runTool("mkvmerge", ["-J", resolve(input)]);
  return {
    input: resolve(input),
    tracks: parseMkvSubtitleTracks(JSON.parse(stdout)),
  };
}

export async function extractMkvTracks({ input, tracks = [], outDir }) {
  if (!tracks.length) throw new Error("No subtitle tracks selected for extraction.");
  const resolvedInput = resolve(input);
  const resolvedOutDir = resolve(outDir ?? join(dirname(resolvedInput), "extracted-subtitles"));
  await mkdir(resolvedOutDir, { recursive: true });
  const plan = buildMkvExtractPlan(resolvedInput, tracks, resolvedOutDir);
  await runTool("mkvextract", ["tracks", resolvedInput, ...plan.map((item) => item.spec)]);
  // The plan's outputs are predictions; report only files that exist. If
  // mkvextract names its outputs differently than predicted (its VobSub
  // extractor derives sidecar names itself), returning the predicted paths
  // would report success for files that were never written.
  // TODO(verify with a real VobSub MKV): `mkvextract tracks in.mkv 2:/tmp/probe.sub`
  // — if it writes probe.sub.idx/probe.sub.sub, the spec should be built with
  // .idx and the .sub derived, not the reverse.
  const missing = plan.flatMap((item) => item.outputs).filter((path) => !existsSync(path));
  if (missing.length) {
    throw new Error(
      `mkvextract finished but did not write: ${missing.map((path) => basename(path)).join(", ")}. ` +
        "The extraction did not produce the expected files.",
    );
  }
  return {
    input: resolvedInput,
    outDir: resolvedOutDir,
    outputs: plan.flatMap((item) => item.outputs),
    tracks: plan.map((item) => item.track),
  };
}

function languageLabel(code) {
  const names = {
    eng: "English",
    fre: "French",
    fra: "French",
    spa: "Spanish",
    ger: "German",
    deu: "German",
    dut: "Dutch",
    nld: "Dutch",
    ita: "Italian",
    por: "Portuguese",
    jpn: "Japanese",
    kor: "Korean",
    und: "Undetermined",
  };
  return names[code] ?? code;
}
