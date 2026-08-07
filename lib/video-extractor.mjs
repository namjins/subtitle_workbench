import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

// Single source of truth for what this tool claims to extract. The bridge
// derives its request allowlist from this set so the two cannot drift apart.
export const subtitleCodecs = new Set(["S_VOBSUB", "S_HDMV/PGS", "S_DVBSUB"]);

export function subtitleFormat(codec = "") {
  if (codec.startsWith("S_VOBSUB")) return "sub + idx";
  if (codec.startsWith("S_HDMV/PGS") || codec.startsWith("S_DVBSUB")) return "sup";
  return "sup";
}

export function subtitleExtension(codec = "") {
  return subtitleFormat(codec) === "sub + idx" ? "sub" : "sup";
}

export function parseMkvSubtitleTracks(info) {
  return (info.tracks ?? [])
    .filter((track) => track.type === "subtitles")
    .filter((track) => subtitleCodecs.has(codecId(track)))
    .map((track, index) => {
      const languageCode = track.properties?.language ?? "und";
      const languageIetf = track.properties?.language_ietf;
      const codec = codecId(track);
      return {
        id: String(track.id),
        trackId: track.id,
        label: `${languageLabel(languageCode)} (${languageCode})${track.properties?.forced_track ? " forced" : ""}`,
        languageCode,
        language: languageLabel(languageCode),
        languageIetf,
        codec,
        format: subtitleFormat(codec),
        defaultTrack: Boolean(track.properties?.default_track),
        forcedTrack: Boolean(track.properties?.forced_track),
        index,
      };
    });
}

function codecId(track) {
  return track.properties?.codec_id ?? track.codec ?? "";
}

export function outputStem(input, outputIndex, track) {
  const name = basename(input, extname(input)) || "subtitles";
  const suffixes = [];
  if (track.languageCode && track.languageCode !== "eng") suffixes.push(track.languageCode);
  if (track.forcedTrack) suffixes.push("forced");
  const suffix = suffixes.length ? `-${suffixes.join("-")}` : "";
  return outputIndex === 0 ? `${name}${suffix}` : `${name}${outputIndex}${suffix}`;
}

export function buildMkvExtractPlan(input, tracks, outDir) {
  return tracks.map((track, outputIndex) => {
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
  const stdout = await runTool("mkvmerge", ["-J", input]);
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
