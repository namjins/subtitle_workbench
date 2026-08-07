"use client";

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import {
  extractBridgeVideo,
  fetchBridgeDoctorReport,
  inspectBridgeVideo,
  pickBridgeFile,
  pickBridgeFiles,
  revealBridgeFile,
  runBridgeJob,
  uploadBridgeFiles,
  type BridgeVideoTrack,
} from "./localBridgeClient";
import { extractPgsPreviewsFromBuffer, type PgsPreview } from "./pgsPreview";

type ToolId = "sup" | "subidx" | "itt" | "extract";
type QueueStep = "intake" | "review" | "run";
type ExtractStage = QueueStep;
type ExtractStatus = "ready" | "queued" | "extracting" | "complete";
type OcrRunStatus = "idle" | "running" | "complete";

type BatchItem = {
  id: string;
  kind: "sup" | "subidx" | "itt";
  name: string;
  language?: string;
  previews?: PgsPreview[];
  selected: boolean;
  sourcePath?: string;
  files?: File[];
};

type ExtractTrack = {
  id: string;
  trackId: number;
  label: string;
  languageCode: string;
  language: string;
  codec: string;
  format: "sub + idx" | "sup";
  defaultTrack: boolean;
  forcedTrack: boolean;
  status: ExtractStatus;
  progress: number;
};

type WebkitFileEntry = {
  isDirectory: boolean;
  isFile: boolean;
  file: (
    successCallback: (file: File) => void,
    errorCallback?: (error: DOMException) => void,
  ) => void;
  createReader?: () => {
    readEntries: (
      successCallback: (entries: WebkitFileEntry[]) => void,
      errorCallback?: (error: DOMException) => void,
    ) => void;
  };
};

// The DOM lib types webkitGetAsEntry as returning FileSystemEntry, which does
// not describe the directory-reader shape we actually use, so override it
// rather than intersecting (an intersection keeps the DOM signature and makes
// the narrowing below unsound).
type DataTransferItemWithEntry = Omit<DataTransferItem, "webkitGetAsEntry"> & {
  webkitGetAsEntry?: () => WebkitFileEntry | null;
};

const tools: Array<{
  id: ToolId;
  label: string;
  eyebrow: string;
  detail: string;
}> = [
  {
    id: "sup",
    label: "SUP to SRT",
    eyebrow: "OCR",
    detail: "PGS subtitle image tracks",
  },
  {
    id: "subidx",
    label: "SUB/IDX to SRT",
    eyebrow: "OCR",
    detail: "VobSub subtitle pairs",
  },
  {
    id: "itt",
    label: "ITT to SRT",
    eyebrow: "Text",
    detail: "Final Cut Pro timed text",
  },
  {
    id: "extract",
    label: "Extract from Video",
    eyebrow: "Batch",
    detail: "Embedded subtitle tracks by language",
  },
];

const languageOptions = [
  ["eng", "English"],
  ["nld", "Dutch"],
  ["deu", "German"],
  ["fra", "French"],
  ["spa", "Spanish"],
  ["ita", "Italian"],
  ["por", "Portuguese"],
  ["jpn", "Japanese"],
  ["kor", "Korean"],
  ["chi_sim", "Chinese Simplified"],
  ["chi_tra", "Chinese Traditional"],
] as const;

const queueSteps = [
  ["intake", "Intake"],
  ["review", "Review"],
  ["run", "Run OCR"],
] as const;

const extractQueueStepLabels: Record<QueueStep, string> = {
  intake: "Intake",
  review: "Review",
  run: "Run Extraction",
};

const textQueueStepLabels: Record<QueueStep, string> = {
  intake: "Intake",
  review: "Review",
  run: "Convert",
};

const fpsOptions = [
  ["24000/1001", "23.976"],
  ["24", "24"],
  ["25", "25"],
  ["30000/1001", "29.97"],
  ["30", "30"],
  ["50", "50"],
  ["60000/1001", "59.94"],
  ["60", "60"],
  ["other", "Other"],
] as const;

function baseName(name: string) {
  return name.replace(/\.(sup|sub|idx|itt)$/i, "");
}

function languageName(code?: string) {
  return languageOptions.find(([value]) => value === code)?.[1] ?? code ?? "";
}

function extractFileBase(videoName: string, trackIndex: number) {
  const name = videoName.replace(/\.[^.]+$/i, "") || "subtitles";
  return trackIndex === 0 ? name : `${name}${trackIndex}`;
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? "";
}

function normalizeLocalPath(path: string) {
  return path
    .trim()
    .replace(/^['"]|['"]$/gu, "")
    .replace(/\\([ ()[\]{}&'"!#$;])/gu, "$1");
}

/**
 * A failed fetch to the bridge surfaces as a bare "Failed to fetch", which
 * tells the user nothing. The overwhelmingly common cause is that the bridge
 * is not running, so say that and how to fix it.
 */
export function bridgeFailureMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  const unreachable =
    /failed to fetch|networkerror|load failed|connection refused|fetch failed/iu.test(detail);

  if (unreachable) {
    return "Could not reach the local bridge. Start it with `npm run app`, then run this again.";
  }
  return detail || "The local bridge failed to run this job.";
}

function detectSafeBrowserJobs() {
  const cores = typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency;
  return Math.max(1, Math.min(8, Math.floor(cores || 4) - 1 || 1));
}

async function filesFromEntry(entry: WebkitFileEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file(
        (file) => resolve([file]),
        () => resolve([]),
      );
    });
  }

  if (!entry.isDirectory || !entry.createReader) {
    return [];
  }

  const reader = entry.createReader();
  // readEntries returns at most 100 entries per call and must be drained until
  // it yields an empty array. Calling it once silently dropped everything past
  // the first batch when a folder was dropped.
  const entries: WebkitFileEntry[] = [];
  for (;;) {
    const batch = await new Promise<WebkitFileEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (!batch.length) break;
    entries.push(...batch);
  }

  const nestedFiles = await Promise.all(entries.map((nestedEntry) => filesFromEntry(nestedEntry)));
  return nestedFiles.flat();
}

async function filesFromDrop(dataTransfer: DataTransfer) {
  const entries = Array.from(dataTransfer.items ?? [])
    .map((item) => (item as DataTransferItemWithEntry).webkitGetAsEntry?.())
    .filter((entry): entry is WebkitFileEntry => !!entry);

  if (entries.length) {
    const nestedFiles = await Promise.all(entries.map((entry) => filesFromEntry(entry)));
    const files = nestedFiles.flat();
    if (files.length) return files;
  }

  return Array.from(dataTransfer.files ?? []);
}

export function SubtitleWorkbench() {
  const [active, setActive] = useState<ToolId>("extract");
  // Populated only when the startup dependency check finds required tools
  // missing; when everything is installed the user sees nothing at all. A
  // failed check (bridge unreachable, old bridge without /doctor) also shows
  // nothing — conversions surface their own errors.
  const [missingDependencies, setMissingDependencies] = useState<{
    names: string[];
    install: string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBridgeDoctorReport()
      .then((report) => {
        if (cancelled || report.summary.ready) return;
        setMissingDependencies({
          names: [
            ...report.summary.binaryFailures.map((failure) => failure.name),
            ...report.summary.languageFailures.map(
              (failure) => `tesseract language "${failure.language}"`,
            ),
          ],
          install: report.install,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const [extractStage, setExtractStage] = useState<ExtractStage>("intake");
  const [extractVideoFile, setExtractVideoFile] = useState<File | null>(null);
  const [extractVideoName, setExtractVideoName] = useState("");
  const [extractVideoPath, setExtractVideoPath] = useState("");
  const [extractTracks, setExtractTracks] = useState<ExtractTrack[]>([]);
  const [completedExtractFiles, setCompletedExtractFiles] = useState<string[]>([]);
  const [selectedExtractLanguages, setSelectedExtractLanguages] = useState<string[]>([]);
  const [dragTarget, setDragTarget] = useState<"extract" | "subtitles" | null>(null);
  const [ocrLanguage, setOcrLanguage] = useState("eng");
  const [queueStep, setQueueStep] = useState<QueueStep>("intake");
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  // Keyed by item id, not array position: deleting an earlier row while the
  // language panel was open used to silently re-point it at a different file,
  // and the language was then assigned to the wrong item.
  const [batchLanguageId, setBatchLanguageId] = useState<string | null>(null);
  // Incremented whenever a run starts or the tool changes. Async handlers
  // capture the value at entry and drop their results if it has moved on, so a
  // job that finishes after the user switched tools cannot write its output
  // into the new tool's panel.
  const runToken = useRef(0);
  const batchFileInputRef = useRef<HTMLInputElement | null>(null);
  const extractFileInputRef = useRef<HTMLInputElement | null>(null);
  const [applyLanguageToBatch, setApplyLanguageToBatch] = useState(false);
  const [selectedBatchLanguages, setSelectedBatchLanguages] = useState<string[]>([]);
  const [ocrRunStatus, setOcrRunStatus] = useState<OcrRunStatus>("idle");
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrEtaSeconds, setOcrEtaSeconds] = useState(0);
  const [completedSrtFiles, setCompletedSrtFiles] = useState<string[]>([]);
  // The path field is the fallback for environments without a native picker;
  // Browse fills the path directly, so the field stays out of the way until
  // someone asks for it or the fallback needs it.
  const [showExtractPathField, setShowExtractPathField] = useState(false);
  const [bridgeError, setBridgeError] = useState("");
  const [jobs, setJobs] = useState(detectSafeBrowserJobs);
  const [fpsPreset, setFpsPreset] = useState("24000/1001");
  const [customFps, setCustomFps] = useState("");
  const isSubtitleTool = active === "sup" || active === "subidx" || active === "itt";
  const isIttTool = active === "itt";
  const isOcrTool = active === "sup" || active === "subidx";
  const subtitleToolTitle =
    active === "itt" ? "ITT to SRT" : active === "subidx" ? "SUB/IDX to SRT" : "SUP to SRT";
  const subtitleToolDescription =
    active === "itt"
      ? "Add one or more Final Cut Pro ITT files, choose the source frame rate, then export SRT files."
      : active === "subidx"
      ? "Add one or more VobSub pairs, then review the queue before OCR."
      : "Add one or more SUP files, then review the queue before OCR.";
  const subtitleToolAccept = active === "itt" ? ".itt" : active === "subidx" ? ".sub,.idx" : ".sup";
  const subtitleToolInputLabel =
    active === "itt"
      ? "Select ITT files"
      : active === "subidx"
        ? "Select SUB/IDX files"
        : "Select SUP files";
  const subtitleToolEmptyLabel =
    active === "itt"
      ? "No ITT files selected."
      : active === "subidx"
        ? "No SUB/IDX files selected."
        : "No SUP files selected.";
  const activeBatchItems = batchItems.filter(
    (item) => item.selected && item.kind === active,
  );
  const queueStepIndex = queueSteps.findIndex(([step]) => step === queueStep);
  const unresolvedBatchItems = isOcrTool
    ? activeBatchItems.filter((item) => !item.language)
    : [];
  const batchLanguages = Array.from(
    new Set(activeBatchItems.flatMap((item) => (item.language ? [item.language] : []))),
  );
  // Only ever real paths reported by the CLI. There used to be a predicted
  // list here (`${name}-${language}.srt`) shown when no real output arrived,
  // which could never match what the CLI actually writes (`<base>.srt`) and
  // was displayed even when the run had failed outright.
  const visibleSrtFiles = completedSrtFiles;
  const selectedFps = fpsPreset === "other" ? customFps.trim() : fpsPreset;
  const validSelectedFps = /^\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?$/u.test(selectedFps);
  const currentBatchItem =
    batchLanguageId === null
      ? null
      : activeBatchItems.find((item) => item.id === batchLanguageId) ?? null;
  const extractLanguageChoices = Array.from(
    new Map(
      extractTracks.map((track) => [
        track.languageCode,
        { code: track.languageCode, name: track.language },
      ]),
    ).values(),
  );
  const selectedExtractTracks = extractTracks.filter((track) =>
    selectedExtractLanguages.includes(track.languageCode),
  );
  const extractStepIndex = queueSteps.findIndex(([step]) => step === extractStage);
  const extractRunning = selectedExtractTracks.some((track) =>
    ["queued", "extracting"].includes(track.status),
  );
  const extractComplete =
    !!selectedExtractTracks.length &&
    selectedExtractTracks.every((track) => track.status === "complete");
  const extractProgress = selectedExtractTracks.length
    ? Math.round(
        selectedExtractTracks.reduce((total, track) => total + track.progress, 0) /
          selectedExtractTracks.length,
      )
    : 0;
  const extractOutputFiles = selectedExtractTracks.flatMap((track, index) => {
    const fileBase = extractFileBase(extractVideoName, index);
    return track.format === "sub + idx" ? [`${fileBase}.sub`, `${fileBase}.idx`] : [`${fileBase}.sup`];
  });
  const visibleExtractFiles = completedExtractFiles.length ? completedExtractFiles : extractOutputFiles;

  function selectExtractVideo(file?: File) {
    const path = (file as (File & { path?: string }) | undefined)?.path ?? "";
    setExtractVideoFile(file ?? null);
    setExtractVideoName(file?.name ?? "");
    setExtractVideoPath(path);
    setExtractTracks([]);
    setSelectedExtractLanguages([]);
    setExtractStage("intake");
    setCompletedExtractFiles([]);
    // The fallback file input cannot reveal the path, so the instruction to
    // paste it must come with the field it refers to.
    if (file && !path) setShowExtractPathField(true);
    setBridgeError(
      file && !path
        ? "Paste the MKV's full local path below. Video extraction reads the source in place and does not upload or copy it."
        : "",
    );
  }

  function handleExtractPath(event: ChangeEvent<HTMLInputElement>) {
    const path = normalizeLocalPath(event.target.value);
    setExtractVideoPath(path);
    setExtractVideoName(fileNameFromPath(path) || extractVideoFile?.name || "");
    setExtractTracks([]);
    setSelectedExtractLanguages([]);
    setExtractStage("intake");
    setCompletedExtractFiles([]);
    setBridgeError("");
  }

  async function revealOutputs(paths: string[]) {
    const revealedFolders = new Set<string>();
    for (const path of paths) {
      const folder = path.replace(/[\\/][^\\/]*$/u, "");
      if (revealedFolders.has(folder)) continue;
      revealedFolders.add(folder);
      try {
        await revealBridgeFile(path);
      } catch (error) {
        setBridgeError(bridgeFailureMessage(error));
        return;
      }
      if (revealedFolders.size >= 3) break;
    }
  }

  async function handleExtractBrowse() {
    setBridgeError("");
    try {
      const picked = await pickBridgeFile(["mkv"]);
      // Cancelled dialog: leave everything exactly as it was.
      if (!picked.path) return;
      setExtractVideoFile(null);
      setExtractVideoPath(picked.path);
      setExtractVideoName(picked.name || fileNameFromPath(picked.path));
      setExtractTracks([]);
      setSelectedExtractLanguages([]);
      setExtractStage("intake");
      setCompletedExtractFiles([]);
    } catch {
      // No native picker (non-macOS web bridge): the webview file input at
      // least captures the name, and its handler asks for the path.
      extractFileInputRef.current?.click();
    }
  }

  function handleExtractVideo(event: ChangeEvent<HTMLInputElement>) {
    selectExtractVideo(event.target.files?.[0]);
  }

  async function handleExtractDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragTarget(null);
    const file = (await filesFromDrop(event.dataTransfer)).find((item) =>
      item.name.toLowerCase().endsWith(".mkv"),
    );
    selectExtractVideo(file);
  }

  async function inspectExtractVideo() {
    if (!extractVideoName && !extractVideoPath) return;
    setBridgeError("");
    try {
      const input = normalizeLocalPath(extractVideoPath);
      if (!input) {
        throw new Error(
          "Paste the MKV's full local path to inspect it in place. Video extraction does not upload or copy source videos.",
        );
      }
      const result = await inspectBridgeVideo(input);
      const tracks: ExtractTrack[] = result.tracks.map((track) => ({
        ...track,
        status: "ready",
        progress: 0,
      }));
      setExtractTracks(tracks);
      setSelectedExtractLanguages(Array.from(new Set(tracks.map((track) => track.languageCode))));
      setExtractStage("review");
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : "Video inspection failed.");
    }
  }

  function toggleExtractLanguage(languageCode: string) {
    setSelectedExtractLanguages((languages) =>
      languages.includes(languageCode)
        ? languages.filter((language) => language !== languageCode)
        : [...languages, languageCode],
    );
  }

  function selectAllExtractLanguages() {
    setSelectedExtractLanguages(extractLanguageChoices.map((language) => language.code));
  }

  function clearExtractLanguages() {
    setSelectedExtractLanguages([]);
  }

  async function startAllExtractTracks() {
    const firstPending = selectedExtractTracks.find((track) => track.status !== "complete");
    if (!firstPending || !extractVideoPath) return;
    setExtractStage("run");
    setBridgeError("");
    setCompletedExtractFiles([]);
    setExtractTracks((tracks) =>
      tracks.map((track) => {
        if (!selectedExtractLanguages.includes(track.languageCode)) return track;
        if (track.status === "complete") return track;
        return track.id === firstPending.id
          ? { ...track, status: "extracting", progress: 28 }
          : { ...track, status: "queued", progress: 0 };
      }),
    );
    // Held so the catch below can cancel it. Previously this timer was left
    // running, so a bridge failure that arrived within 500ms reset the rows to
    // "ready" and then the timer flipped them back to "extracting" at 65%,
    // wedging the UI with no way forward except clearing the queue.
    runToken.current += 1;
    const token = runToken.current;
    const isCurrentRun = () => runToken.current === token;

    const advanceProgress = window.setTimeout(() => {
      if (!isCurrentRun()) return;
      setExtractTracks((tracks) =>
        tracks.map((track) =>
          selectedExtractLanguages.includes(track.languageCode) && track.status !== "complete"
            ? { ...track, status: "extracting", progress: 65 }
            : track,
        ),
      );
    }, 500);

    try {
      const result = await extractBridgeVideo(
        extractVideoPath,
        selectedExtractTracks.map((track): BridgeVideoTrack => ({
          id: track.id,
          trackId: track.trackId,
          label: track.label,
          languageCode: track.languageCode,
          language: track.language,
          codec: track.codec,
          format: track.format,
          defaultTrack: track.defaultTrack,
          forcedTrack: track.forcedTrack,
          index: 0,
        })),
      );
      window.clearTimeout(advanceProgress);
      if (!isCurrentRun()) return;
      setCompletedExtractFiles(result.outputs);
      setExtractTracks((tracks) =>
        tracks.map((track) =>
          selectedExtractLanguages.includes(track.languageCode)
            ? { ...track, status: "complete", progress: 100 }
            : track,
        ),
      );
    } catch (error) {
      window.clearTimeout(advanceProgress);
      if (!isCurrentRun()) return;
      setBridgeError(bridgeFailureMessage(error));
      setCompletedExtractFiles([]);
      setExtractTracks((tracks) =>
        tracks.map((track) =>
          selectedExtractLanguages.includes(track.languageCode)
            ? { ...track, status: "ready", progress: 0 }
            : track,
        ),
      );
    }
  }

  async function loadSubtitleFiles(files: File[]) {
    const supFiles: File[] = [];
    const ittFiles: File[] = [];
    const subIdxGroups = new Map<string, { idx?: File; sub?: File }>();

    for (const file of files) {
      const lowerName = file.name.toLowerCase();
      if (active === "sup" && lowerName.endsWith(".sup")) {
        supFiles.push(file);
      } else if (active === "itt" && lowerName.endsWith(".itt")) {
        ittFiles.push(file);
      } else if (
        active === "subidx" &&
        (lowerName.endsWith(".idx") || lowerName.endsWith(".sub"))
      ) {
        const name = baseName(file.name);
        const group = subIdxGroups.get(name) ?? {};
        if (lowerName.endsWith(".idx")) {
          group.idx = file;
        } else {
          group.sub = file;
        }
        subIdxGroups.set(name, group);
      }
    }

    const unmatchedIdx = Array.from(subIdxGroups.values()).filter(
      (group) => group.idx && !group.sub,
    );
    const unmatchedSub = Array.from(subIdxGroups.values()).filter(
      (group) => group.sub && !group.idx,
    );
    if (files.length === 2 && unmatchedIdx.length === 1 && unmatchedSub.length === 1) {
      subIdxGroups.clear();
      subIdxGroups.set(baseName(unmatchedIdx[0].idx?.name ?? "subtitle"), {
        idx: unmatchedIdx[0].idx,
        sub: unmatchedSub[0].sub,
      });
    }

    // Sequential, and only for files small enough to be worth previewing.
    // Promise.all here read every .sup fully into memory at once and then ran a
    // synchronous byte scan per file on the main thread, which froze or killed
    // the tab when a folder of large tracks was dropped.
    const maxPreviewBytes = 64 * 1024 * 1024;
    const supItems: BatchItem[] = [];
    for (const [index, file] of supFiles.entries()) {
      let previews: PgsPreview[] = [];
      if (file.size <= maxPreviewBytes) {
        try {
          previews = extractPgsPreviewsFromBuffer(await file.arrayBuffer(), 3);
        } catch {
          previews = [];
        }
      }
      supItems.push({
        id: `${file.name}-${index}-${file.size}`,
        kind: "sup",
        name: baseName(file.name),
        previews,
        selected: true,
        sourcePath: (file as File & { path?: string }).path,
        files: [file],
      });
    }
    const subIdxItems: BatchItem[] = Array.from(subIdxGroups.entries())
      .filter(([, group]) => group.idx && group.sub)
      .map(([name, group], index) => ({
        id: `${name}-subidx-${index}`,
        kind: "subidx",
        name,
        previews: [],
        selected: true,
        sourcePath: (group.idx as File & { path?: string }).path,
        files: [group.idx, group.sub].filter((file): file is File => !!file),
      }));
    const ittItems: BatchItem[] = ittFiles.map((file, index) => ({
      id: `${file.name}-itt-${index}-${file.size}`,
      kind: "itt",
      name: baseName(file.name),
      previews: [],
      selected: true,
      sourcePath: (file as File & { path?: string }).path,
      files: [file],
    }));
    const items = [...supItems, ...subIdxItems, ...ittItems].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    if (!items.length) {
      setBridgeError(
        active === "itt"
          ? "Drop one or more .itt files, or select them with Browse."
          : active === "subidx"
          ? "Drop matching .sub and .idx files, or select both files with Browse."
          : "Drop one or more .sup files, or select them with Browse.",
      );
      return;
    }
    installBatchItems(items);
  }

  function installBatchItems(items: BatchItem[]) {
    // Replace only this tool's queue. The whole array used to be overwritten,
    // so adding SUP files silently discarded a SUB/IDX or ITT queue the user
    // had already built up in another tab.
    setBatchItems((existing) => [
      ...existing.filter((item) => item.kind !== active),
      ...items,
    ]);
    setOcrRunStatus("idle");
    setOcrProgress(0);
    setOcrEtaSeconds(0);
    setCompletedSrtFiles([]);
    setBridgeError("");
    setSelectedBatchLanguages([]);
  }

  /**
   * Intake for files chosen through the native picker: real local paths the
   * bridge converts in place, with no copy into an upload workspace. SUP
   * previews need the bytes, which a path alone cannot provide, so natively
   * picked items simply have none.
   */
  function loadSubtitlePaths(paths: string[]) {
    const wanted = active === "subidx" ? /\.idx$/iu : active === "itt" ? /\.itt$/iu : /\.sup$/iu;
    // For SUB/IDX the .idx is the input; a picked .sub only tells us the user
    // grabbed the pair, and the converter finds it beside the .idx anyway.
    const inputs = paths.filter((path) => wanted.test(path));
    const items: BatchItem[] = inputs.map((path, index) => ({
      id: `${path}-${index}`,
      kind: active === "extract" ? "sup" : active,
      name: baseName(fileNameFromPath(path)),
      previews: [],
      selected: true,
      sourcePath: path,
      files: [],
    }));
    if (!items.length) {
      setBridgeError(
        active === "subidx"
          ? "Pick the .idx file (its matching .sub must sit beside it)."
          : `Pick one or more .${active} files.`,
      );
      return;
    }
    installBatchItems(items);
  }

  async function handleBatchBrowse() {
    const extensions =
      active === "subidx" ? ["idx", "sub"] : active === "itt" ? ["itt"] : ["sup"];
    try {
      const picked = await pickBridgeFiles(extensions);
      // Cancelled dialog: leave everything exactly as it was.
      if (!picked.length) return;
      loadSubtitlePaths(picked.flatMap((file) => (file.path ? [file.path] : [])));
    } catch {
      // No native picker here (non-macOS web bridge): fall back to the
      // browser's file input, which uploads copies instead.
      batchFileInputRef.current?.click();
    }
  }

  async function handleBatchFiles(event: ChangeEvent<HTMLInputElement>) {
    await loadSubtitleFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  async function handleSubtitleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragTarget(null);
    await loadSubtitleFiles(await filesFromDrop(event.dataTransfer));
  }

  function resetBatch() {
    runToken.current += 1;
    // Clearing is also per-tool, for the same reason.
    setBatchItems((existing) => existing.filter((item) => item.kind !== active));
    setBatchLanguageId(null);
    setApplyLanguageToBatch(false);
    setSelectedBatchLanguages([]);
    setOcrRunStatus("idle");
    setOcrProgress(0);
    setOcrEtaSeconds(0);
    setCompletedSrtFiles([]);
    setBridgeError("");
    setQueueStep("intake");
  }

  function resetExtract() {
    runToken.current += 1;
    setExtractVideoFile(null);
    setExtractVideoName("");
    setExtractVideoPath("");
    setExtractTracks([]);
    setSelectedExtractLanguages([]);
    setExtractStage("intake");
    setCompletedExtractFiles([]);
    setBridgeError("");
  }

  function openBatchLanguage(index = 0) {
    if (!isOcrTool) return;
    const target = activeBatchItems[index];
    if (!target) return;
    setBatchLanguageId(target.id);
    setOcrLanguage(target.language ?? "eng");
    setApplyLanguageToBatch(false);
  }

  function confirmBatchLanguage(language = ocrLanguage) {
    if (!isOcrTool) return;
    if (batchLanguageId === null) return;
    const target = activeBatchItems.find((item) => item.id === batchLanguageId);
    if (!target) return;
    setBatchItems((items) =>
      items.map((item) => {
        if (!item.selected) return item;
        if (item.kind !== target.kind) return item;
        if (applyLanguageToBatch || item.id === target.id) {
          return { ...item, language };
        }
        return item;
      }),
    );
    setSelectedBatchLanguages((languages) =>
      languages.includes(language) ? languages : [...languages, language],
    );
    setBatchLanguageId(null);
    setQueueStep("review");
  }

  function deleteBatchItem(id: string) {
    const remainingActiveItems = activeBatchItems.filter((item) => item.id !== id);
    setBatchItems((items) =>
      items.map((item) => (item.id === id ? { ...item, selected: false } : item)),
    );
    if (!remainingActiveItems.length) {
      setBatchLanguageId(null);
      setQueueStep("intake");
    }
  }

  async function startBatch() {
    if (ocrRunStatus === "running") return;
    if (isOcrTool && !selectedBatchLanguages.length) return;
    if (isIttTool && (!activeBatchItems.length || !validSelectedFps)) {
      setBridgeError("Choose a valid source FPS before converting ITT files.");
      return;
    }
    runToken.current += 1;
    const token = runToken.current;
    const isCurrentRun = () => runToken.current === token;

    setOcrRunStatus("running");
    setOcrProgress(0);
    setOcrEtaSeconds(0);
    setCompletedSrtFiles([]);
    setBridgeError("");

    const runnableBatchItems = isIttTool
      ? activeBatchItems
      : activeBatchItems.filter(
          (item) => item.language && selectedBatchLanguages.includes(item.language),
        );
    let bridgeItems = runnableBatchItems.filter((item) => item.sourcePath);
    try {
      if (bridgeItems.length !== runnableBatchItems.length) {
        const uploadItems = runnableBatchItems.filter((item) => !item.sourcePath && item.files?.length);
        if (uploadItems.length) {
          const uploadedItems = await Promise.all(
            uploadItems.map(async (item) => {
              const uploaded = await uploadBridgeFiles(item.files ?? []);
              const uploadedPaths = new Map(uploaded.files.map((file) => [file.name, file.path]));
              const idxPath = item.files
                ?.map((file) => uploadedPaths.get(file.name))
                .find((path, index) => path && item.files?.[index]?.name.toLowerCase().endsWith(".idx"));
              const firstPath = item.files
                ?.map((file) => uploadedPaths.get(file.name))
                .find((path): path is string => !!path);
              return {
                ...item,
                sourcePath: active === "subidx" ? idxPath : firstPath,
              };
            }),
          );
          const uploadedItemPaths = new Map(uploadedItems.map((item) => [item.id, item.sourcePath]));
          bridgeItems = runnableBatchItems
            .map((item) => {
              if (item.sourcePath) return item;
              return {
                ...item,
                sourcePath: uploadedItemPaths.get(item.id),
              };
            })
            .filter((item): item is BatchItem & { sourcePath: string } => !!item.sourcePath);

          // Remember where the bridge put each upload. Without this a retry
          // re-uploaded every file and left another temp workspace behind.
          if (isCurrentRun()) {
            setBatchItems((items) =>
              items.map((item) => {
                const uploadedPath = uploadedItemPaths.get(item.id);
                return uploadedPath && !item.sourcePath
                  ? { ...item, sourcePath: uploadedPath }
                  : item;
              }),
            );
          }
        }
      }
      if (!runnableBatchItems.length) {
        throw new Error("Nothing to run: no queued files matched the selected languages.");
      }
      if (bridgeItems.length !== runnableBatchItems.length) {
        throw new Error(
          "Could not resolve a local path for every queued file. Remove and re-add the files, then try again.",
        );
      }

      const outputs: string[] = [];
      const groups = new Map<string, BatchItem[]>();
      if (isIttTool) {
        groups.set("itt", bridgeItems);
      } else {
        for (const item of bridgeItems) {
          groups.set(item.language ?? "eng", [...(groups.get(item.language ?? "eng") ?? []), item]);
        }
      }
      // Progress is per file, from the CLI's own job-finished events. It used
      // to be per language group, so a 40-file single-language batch sat at 0%
      // and then jumped straight to 100%.
      const totalFiles = bridgeItems.length;
      let finishedFiles = 0;
      const startedAt = Date.now();

      for (const [language, items] of groups) {
        await runBridgeJob(
          {
            command: isIttTool ? "itt-to-srt" : active === "subidx" ? "subidx-to-srt" : "sup-to-srt",
            inputs: items.flatMap((item) => item.sourcePath ?? []),
            language: isIttTool ? undefined : language,
            fps: isIttTool ? selectedFps : undefined,
            jobs: isIttTool ? undefined : jobs,
            ocrEngine: "auto",
          },
          (event) => {
            if (!isCurrentRun()) return;

            if (event.output && typeof event.output === "string") {
              // job-started and job-finished both carry `output`, so the same
              // file arrived twice and rendered with duplicate React keys.
              if (!outputs.includes(event.output)) outputs.push(event.output);
              setCompletedSrtFiles([...outputs]);
            }

            if (event.type === "job-finished") {
              finishedFiles += 1;
              setOcrProgress(
                Math.min(100, Math.round((finishedFiles / Math.max(1, totalFiles)) * 100)),
              );
              // Estimate from measured throughput rather than a fixed guess.
              const elapsed = (Date.now() - startedAt) / 1000;
              const remaining = Math.max(0, totalFiles - finishedFiles);
              setOcrEtaSeconds(
                finishedFiles > 0 ? Math.round((elapsed / finishedFiles) * remaining) : 0,
              );
            }
          },
        );
      }

      if (!isCurrentRun()) return;
      setOcrProgress(100);
      setOcrEtaSeconds(0);
      setOcrRunStatus("complete");
    } catch (error) {
      // A run the user has already navigated away from must not write its
      // failure into whatever panel is on screen now.
      if (!isCurrentRun()) return;
      // Every failure path lands here and stops. There used to be a fallthrough
      // to a setTimeout chain that ended in `complete` at 100%, so a run that
      // produced no files at all — including one that never reached the bridge
      // — was reported as a success.
      setBridgeError(bridgeFailureMessage(error));
      setOcrProgress(0);
      setOcrEtaSeconds(0);
      setCompletedSrtFiles([]);
      // Back to idle, not complete: the queue is intact so the run can be
      // retried once the bridge is reachable.
      setOcrRunStatus("idle");
    }
  }

  function queueStepClass(stepIndex: number) {
    if (ocrRunStatus === "complete") return "complete";
    if (stepIndex < queueStepIndex) return "complete";
    if (stepIndex === queueStepIndex) return "active";
    return "pending";
  }

  function extractStepClass(stepIndex: number) {
    if (extractComplete) return "complete";
    if (stepIndex < extractStepIndex) return "complete";
    if (stepIndex === extractStepIndex) return "active";
    return "pending";
  }

  function selectTool(toolId: ToolId) {
    // Any run still in flight belongs to the tool we are leaving.
    runToken.current += 1;
    setActive(toolId);
    setDragTarget(null);
    setBridgeError("");
    if (toolId === "extract") {
      setExtractStage("intake");
      return;
    }
    setQueueStep("intake");
    setBatchLanguageId(null);
    setApplyLanguageToBatch(false);
    setSelectedBatchLanguages([]);
    setOcrRunStatus("idle");
    setOcrProgress(0);
    setOcrEtaSeconds(0);
    setCompletedSrtFiles([]);
  }

  return (
    <main className="workbench">
      <section className="topbar" aria-label="Workspace">
        <div>
          <p className="kicker">Subtitle Workbench</p>
          <h1>Subtitle workbench</h1>
        </div>
      </section>

      {missingDependencies ? (
        <section className="dependency-warning" role="alert">
          <strong>Some required tools are missing:</strong>{" "}
          {missingDependencies.names.join(", ")}. Conversions that need them
          will fail until they are installed.
          <pre>{missingDependencies.install.join("\n")}</pre>
        </section>
      ) : null}

      <section className="tool-grid" aria-label="Subtitle tools">
        {tools.map((tool) => (
          <button
            className={tool.id === active ? "tool-card active" : "tool-card"}
            key={tool.id}
            onClick={() => selectTool(tool.id)}
            type="button"
          >
            <span>{tool.eyebrow}</span>
            <strong>{tool.label}</strong>
            <small>{tool.detail}</small>
          </button>
        ))}
      </section>

      <section className="workspace-shell">
        <section className="main-panel">
          {active === "extract" ? (
            <div className="extract-page">
              {extractStage === "intake" ? (
                <div className="extract-start-page">
                  <div className="converter-title">
                    <h2>Extract Subtitles from Video</h2>
                    <p>
                      Pick an MKV, review the subtitle tracks it contains, and
                      export the tracks you want to keep.
                    </p>
                  </div>

                  <ol className="batch-tabs" aria-label="Extract steps">
                    {queueSteps.map(([step, label], index) => (
                      <button
                        className={extractStepClass(index)}
                        key={step}
                        type="button"
                        onClick={() => setExtractStage(step)}
                      >
                        {extractQueueStepLabels[step] ?? label}
                      </button>
                    ))}
                  </ol>

                  <div className="native-form">
                    <label className="native-label" htmlFor="extract-video">
                      Select your MKV file
                    </label>
                    <div
                      className={
                        dragTarget === "extract"
                          ? "native-file-box extract-file-box drag-active"
                          : "native-file-box extract-file-box"
                      }
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDragTarget("extract");
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragTarget("extract");
                      }}
                      onDragLeave={() => setDragTarget(null)}
                      onDrop={handleExtractDrop}
                    >
                      <button
                        className="browse-button"
                        type="button"
                        onClick={handleExtractBrowse}
                      >
                        Browse...
                      </button>
                      <input
                        accept=".mkv"
                        id="extract-video"
                        onChange={handleExtractVideo}
                        ref={extractFileInputRef}
                        type="file"
                      />
                      <span>{extractVideoName || "No file selected."}</span>
                      <small>or drop an MKV here</small>
                    </div>
		                    <p className="supported-copy">
		                      Currently tested with MKV files. Extraction uses the
		                      source path directly so large videos are not copied.
		                    </p>
	                    {showExtractPathField ? (
	                      <label className="field-stack extract-path-field">
	                        <span>Local MKV path</span>
	                        <div className="path-picker-row">
	                          <input
	                            onChange={handleExtractPath}
	                            placeholder="/path/to/videos/Example.mkv"
	                            type="text"
	                            value={extractVideoPath}
	                          />
	                        </div>
	                      </label>
	                    ) : (
	                      <button
	                        className="text-link"
	                        type="button"
	                        onClick={() => setShowExtractPathField(true)}
	                      >
	                        Or paste a file path instead
	                      </button>
	                    )}
		                    {bridgeError ? <p className="error-text">{bridgeError}</p> : null}
		                    <div className="convert-action-row">
	                      <button
	                        disabled={!extractVideoPath}
	                        type="button"
	                        onClick={inspectExtractVideo}
                      >
                        Continue
                      </button>
                    </div>
                  </div>

                  <article className="about-copy">
                    <h2>What this extractor does</h2>
                    <p>
                      Many MKV files store subtitles inside the video
                      container. This workflow inspects embedded image-subtitle
                      tracks and exports each one in the format used by the
                      source: DVD VobSub as .sub plus .idx, and Blu-ray/UHD PGS
                      as .sup.
                    </p>
                    <h2>Local processing</h2>
                    <p>
                      Extraction runs against the file on your own machine. The
                      video does not need to leave your computer.
                    </p>
                    <h2>DVD and Blu-ray sources</h2>
                    <p>
                      DVD subtitle tracks usually arrive as VobSub, split
                      across a .sub image payload and an .idx timing/palette
                      file. Blu-ray and UHD subtitle tracks usually arrive as a
                      single PGS .sup file.
                    </p>
                  </article>
                </div>
		              ) : (
		                <div className="extract-results-page">
		                  <div className="batch-nav compact-nav">
		                    <button
		                      className="delete-link"
		                      type="button"
		                      onClick={resetExtract}
		                    >
		                      Clear queue
		                    </button>
		                  </div>
		                  <div className="converter-title compact-title">
		                    <h2>Extract Subtitles from Video</h2>
		                    <p>
		                      {extractStage === "review"
		                        ? "Review the detected tracks and choose what to keep."
		                        : "Run extraction, then review the files created from the selected tracks."}
		                    </p>
		                  </div>
		                  <ol className="batch-tabs" aria-label="Extract steps">
		                    {queueSteps.map(([step, label], index) => (
		                      <button
		                        className={extractStepClass(index)}
		                        key={step}
		                        type="button"
		                        onClick={() => setExtractStage(step)}
		                      >
		                        {extractQueueStepLabels[step] ?? label}
		                        {step === "review" && extractTracks.length ? (
		                          <span className="tab-badge">{extractTracks.length}</span>
		                        ) : null}
		                      </button>
		                    ))}
		                  </ol>
		                  <p className="file-name-row">File name: {extractVideoName}</p>
		
		                  {extractStage === "review" ? (
		                    <div className="batch-files-panel">
		                      <p className="review-guidance">
		                        {selectedExtractTracks.length
		                          ? `${selectedExtractTracks.length} track(s) selected for extraction.`
		                          : "Choose at least one language before continuing."}
		                      </p>
		                      <div className="language-picker-panel">
		                        <div className="language-picker-head">
		                          <div>
		                            <p className="panel-label">Detected subtitle languages</p>
		                            <h2>Choose languages to extract</h2>
		                          </div>
		                          <div className="language-bulk-actions">
		                            <button type="button" onClick={selectAllExtractLanguages}>
		                              Select all
		                            </button>
		                            <button type="button" onClick={clearExtractLanguages}>
		                              Unselect all
		                            </button>
		                          </div>
		                        </div>
		                        <div className="language-checkbox-list" aria-label="Subtitle languages">
		                          {extractLanguageChoices.map((language) => (
		                            <label className="language-checkbox" key={language.code}>
		                              <input
		                                checked={selectedExtractLanguages.includes(language.code)}
		                                onChange={() => toggleExtractLanguage(language.code)}
		                                type="checkbox"
		                              />
		                              <span>
		                                {language.name} ({language.code})
		                              </span>
		                            </label>
		                          ))}
		                        </div>
		                      </div>
		                      <div className="extract-table">
		                        <div className="extract-table-head">
		                          <strong>Subtitle tracks</strong>
		                          <span>Selection</span>
		                        </div>
		                        {extractTracks.map((track) => {
		                          const isSelected = selectedExtractLanguages.includes(track.languageCode);
		                          return (
		                            <div
		                              className={
		                                isSelected
		                                  ? "extract-track-row"
		                                  : "extract-track-row muted"
		                              }
		                              key={track.id}
		                            >
		                              <div>
		                                <span>
		                                  {track.label} - {track.format}
		                                </span>
		                                <small>
		                                  {isSelected
		                                    ? "Will be extracted"
		                                    : "Not selected for extraction"}
		                                </small>
		                              </div>
		                              <div className="extract-track-actions">
		                                <span>{isSelected ? "Selected" : "Skipped"}</span>
		                              </div>
		                            </div>
		                          );
		                        })}
		                      </div>
		                      <div className="convert-action-row">
		                        <button
		                          disabled={!selectedExtractTracks.length}
		                          type="button"
		                          onClick={() => selectedExtractTracks.length && setExtractStage("run")}
		                        >
		                          Continue
		                        </button>
		                      </div>
		                    </div>
		                  ) : null}
		
		                  {extractStage === "run" ? (
		                    <div className="batch-start-panel">
		                      <p>
		                        Extract the selected subtitle tracks. File actions appear once extraction has finished.
		                      </p>
		                      <div className="start-language-list">
		                        <h2>Languages</h2>
		                        {extractLanguageChoices.length ? (
		                          extractLanguageChoices.map((language) => (
		                            <label key={language.code}>
		                              <input
		                                checked={selectedExtractLanguages.includes(language.code)}
		                                onChange={() => toggleExtractLanguage(language.code)}
		                                type="checkbox"
		                              />
		                              <span>{language.name}</span>
		                            </label>
		                          ))
		                        ) : (
		                          <label>
		                            <input disabled type="checkbox" />
		                            <span>No detected languages</span>
		                          </label>
		                        )}
		                      </div>
		                      <label className="fps-control compact">
		                        <span>Jobs</span>
		                        <input
		                          min="1"
		                          max="12"
		                          step="1"
		                          type="number"
		                          value={jobs}
		                          onChange={(event) => setJobs(Number(event.target.value))}
		                        />
		                      </label>
		                      <div className="start-batch-box">
		                        {bridgeError ? <p className="error-text">{bridgeError}</p> : null}
		                        <h2>
		                          {extractComplete
		                            ? "Extracted files ready"
		                            : extractRunning
		                              ? "Running extraction"
		                              : "Ready to run"}
		                        </h2>
		                        {extractRunning ? (
		                          <div className="ocr-progress-panel">
		                            {bridgeError ? <p>{bridgeError}</p> : null}
		                            <div className="progress-meter" aria-label="Extraction progress">
		                              <span style={{ width: `${extractProgress}%` }} />
		                            </div>
		                            <p>{extractProgress}% complete</p>
		                          </div>
		                        ) : extractComplete ? (
		                          <>
		                            <div className="result-actions">
		                              <button
		                                className="primary"
		                                type="button"
		                                onClick={() => revealOutputs(visibleExtractFiles)}
		                              >
		                                Show extracted files
		                              </button>
		                              <button className="danger" type="button" onClick={resetExtract}>
		                                Clear queue
		                              </button>
		                            </div>
		                          </>
		                        ) : selectedExtractTracks.length ? (
		                          <button type="button" onClick={startAllExtractTracks}>
		                            Run Extraction
		                          </button>
		                        ) : (
		                          <p>Choose at least one language before running extraction.</p>
		                        )}
		                      </div>
		                    </div>
		                  ) : null}
		                </div>
		              )}
            </div>
          ) : null}

          {isSubtitleTool ? (
              <div className="batch-page">
                <div className="batch-nav compact-nav">
                  <button
                    className="delete-link"
                    type="button"
                    onClick={resetBatch}
                  >
                    Clear queue
                  </button>
                </div>

                <div className="converter-title">
                  <h2>{subtitleToolTitle}</h2>
                  <p>{subtitleToolDescription}</p>
                </div>

                <ol className="batch-tabs" aria-label="Queue steps">
                  {queueSteps.map(([step, label], index) => (
                    <button
                      className={queueStepClass(index)}
                      key={step}
                      type="button"
                      onClick={() => setQueueStep(step)}
                    >
	                      {isIttTool ? textQueueStepLabels[step] : label}
                      {step === "review" && activeBatchItems.length ? (
                        <span className="tab-badge">{activeBatchItems.length}</span>
                      ) : null}
                    </button>
                  ))}
                </ol>

                {queueStep === "intake" ? (
                  <div className="batch-upload-panel">
                    <label className="native-label" htmlFor="batch-files">
                      {subtitleToolInputLabel}
                    </label>
                    <div
                      className={
                        dragTarget === "subtitles"
                          ? "native-file-box batch-file-box drag-active"
                          : "native-file-box batch-file-box"
                      }
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDragTarget("subtitles");
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragTarget("subtitles");
                      }}
                      onDragLeave={() => setDragTarget(null)}
                      onDrop={handleSubtitleDrop}
                    >
                      <button
                        className="browse-button"
                        type="button"
                        onClick={handleBatchBrowse}
                      >
                        Browse...
                      </button>
                      <input
                        accept={subtitleToolAccept}
                        id="batch-files"
                        multiple
                        onChange={handleBatchFiles}
                        ref={batchFileInputRef}
                        type="file"
                      />
                      <span>{subtitleToolEmptyLabel}</span>
	                      <small>
		                        or drop {active === "itt" ? "ITT files" : active === "subidx" ? "SUB/IDX files" : "SUP files"} here
	                      </small>
	                    </div>
	                    {bridgeError ? <p className="error-text">{bridgeError}</p> : null}
	                    {activeBatchItems.length ? (
	                      <div className="upload-success">
	                        <strong>Added to queue</strong>
                        <span>{activeBatchItems.length} job(s) ready for review</span>
                      </div>
                    ) : null}
                    <div className="convert-action-row">
                      <button
                        disabled={!activeBatchItems.length}
                        type="button"
                        onClick={() => activeBatchItems.length && setQueueStep("review")}
                      >
                        Review queue
                      </button>
                    </div>
                  </div>
                ) : null}

                {queueStep === "review" ? (
                  <div className="batch-files-panel">
	                    {unresolvedBatchItems.length ? (
	                      <p className="review-guidance">
	                        {unresolvedBatchItems.length} job(s) still need a
	                        language. Use Assign language on each row.
	                      </p>
	                    ) : isIttTool && activeBatchItems.length ? (
	                      <p className="review-guidance">
	                        {activeBatchItems.length} ITT job(s) ready to convert.
	                      </p>
	                    ) : null}
	                    {isOcrTool && currentBatchItem ? (
                      <div className="queue-language-panel">
                        <div className="queue-language-head">
                          <div>
                            <p className="panel-label">OCR Review</p>
                            <h2>{currentBatchItem.name}</h2>
                          </div>
                          <button
                            className="text-link"
                            type="button"
                            onClick={() => setBatchLanguageId(null)}
                          >
                            Close
                          </button>
                        </div>
                        <p className="plain-copy">
                          Check the subtitle samples, then assign the OCR
                          language for this queue item.
                        </p>
                        <div className="preview-stack compact-preview" aria-label="Subtitle preview images">
                          {currentBatchItem.previews?.length ? (
                            currentBatchItem.previews.map((preview) => (
                              <img
                                alt={`Subtitle preview at ${preview.pts.toFixed(1)} seconds`}
                                key={`${preview.pts}-${preview.width}x${preview.height}`}
                                src={preview.dataUrl}
                              />
                            ))
                          ) : (
                            <div className="preview-placeholder compact-placeholder">
                              No preview available
                              <span>
                                {currentBatchItem.kind === "sup"
                                  ? "This track could not be decoded for preview, or is too large to preview. OCR will still run."
                                  : "Previews are only generated for SUP tracks."}
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="language-picker inline-language-picker">
                          <label className="field-stack">
                            <span>Subtitle image language</span>
                            <select
                              value={ocrLanguage}
                              onChange={(event) => setOcrLanguage(event.target.value)}
                            >
                              <option value="">Select a language...</option>
                              {languageOptions.map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label} ({value})
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="quick-language-row">
                            <button type="button" onClick={() => confirmBatchLanguage("eng")}>
                              English
                            </button>
                            <button type="button" onClick={() => confirmBatchLanguage("fra")}>
                              French
                            </button>
                            <button type="button" onClick={() => confirmBatchLanguage("spa")}>
                              Spanish
                            </button>
                          </div>
                          <label className="apply-row">
                            <input
                              checked={applyLanguageToBatch}
                              onChange={(event) => setApplyLanguageToBatch(event.target.checked)}
                              type="checkbox"
                            />
                            <span>Use this language for remaining one-stream items.</span>
                          </label>
                          <p className="small-note">
                            Existing language choices stay unchanged.
                          </p>
                          <div className="language-actions">
                            <button type="button" onClick={() => setBatchLanguageId(null)}>
                              Cancel
                            </button>
                            <button
                              className="primary"
                              type="button"
                              onClick={() => confirmBatchLanguage()}
                              disabled={!ocrLanguage}
                            >
                              Apply language
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    <div className="batch-file-list">
                      {activeBatchItems.length ? (
                        activeBatchItems.map((item, index) => (
                          <div
                            className={currentBatchItem?.id === item.id ? "selected" : ""}
                            key={item.id}
                          >
                            <strong>{item.name}</strong>
	                            <span>
	                              {isIttTool
	                                ? "1 text subtitle file"
	                                : item.language
	                                  ? "1 stream"
	                                  : "1 stream without language"}
	                            </span>
	                            {!isIttTool && item.language ? (
	                              <small>{languageName(item.language)}</small>
	                            ) : null}
	                            <div className="queue-item-actions">
	                              {isOcrTool ? (
	                                <button
	                                  type="button"
	                                  onClick={() => openBatchLanguage(index)}
	                                >
	                                  {item.language ? "Change language" : "Assign language"}
	                                </button>
	                              ) : null}
                              <button
                                aria-label={`Delete ${item.name}`}
                                type="button"
                                onClick={() => deleteBatchItem(item.id)}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p>No jobs in the queue yet.</p>
                      )}
                    </div>
                    <div className="convert-action-row">
                      <button
                        disabled={!activeBatchItems.length || !!unresolvedBatchItems.length}
                        type="button"
                        onClick={() => {
                          if (activeBatchItems.length && !unresolvedBatchItems.length) {
                            setQueueStep("run");
                          }
                        }}
                      >
                        Continue
                      </button>
                    </div>
                  </div>
                ) : null}

	                {queueStep === "run" ? (
	                  <div className="batch-start-panel">
	                    <p>
	                      {isIttTool
	                        ? "Choose the source frame rate for this queue. SRT actions appear once conversion has finished."
	                        : "Choose which OCR languages should run for this queue. SRT actions appear once OCR has finished."}
	                    </p>
	                    {isIttTool ? (
	                      <div className="start-language-list">
	                        <h2>Frame rate</h2>
	                        <label className="field-stack">
	                          <span>Source FPS</span>
	                          <select
	                            value={fpsPreset}
	                            onChange={(event) => setFpsPreset(event.target.value)}
	                          >
	                            {fpsOptions.map(([value, label]) => (
	                              <option key={value} value={value}>
	                                {label}
	                              </option>
	                            ))}
	                          </select>
	                        </label>
	                        {fpsPreset === "other" ? (
	                          <label className="field-stack">
	                            <span>Custom FPS</span>
	                            <input
	                              placeholder="24000/1001"
	                              value={customFps}
	                              onChange={(event) => setCustomFps(event.target.value)}
	                            />
	                          </label>
	                        ) : null}
	                        <p className="small-note">Using {selectedFps || "custom"} fps.</p>
	                      </div>
	                    ) : (
		                  <>
		                    <div className="start-language-list">
		                      <h2>Languages</h2>
		                      {batchLanguages.length ? (
		                        batchLanguages.map((language) => (
		                          <label key={language}>
		                            <input
		                              checked={selectedBatchLanguages.includes(language)}
		                              onChange={(event) => {
		                                setSelectedBatchLanguages((languages) =>
		                                  event.target.checked
		                                    ? [...new Set([...languages, language])]
		                                    : languages.filter((item) => item !== language),
		                                );
		                              }}
		                              type="checkbox"
		                            />
		                            <span>{languageName(language)}</span>
		                          </label>
		                        ))
		                      ) : (
		                        <label>
		                          <input disabled type="checkbox" />
		                          <span>English</span>
		                        </label>
		                      )}
		                    </div>
		                    <label className="fps-control compact">
		                      <span>Jobs</span>
		                      <input
		                        min="1"
		                        max="12"
		                        step="1"
		                        type="number"
		                        value={jobs}
		                        onChange={(event) => setJobs(Number(event.target.value))}
		                      />
		                    </label>
		                  </>
	                    )}
		                    <div className="start-batch-box">
	                      <h2>
	                        {ocrRunStatus === "complete"
	                          ? "SRT files ready"
	                          : ocrRunStatus === "running"
	                            ? isIttTool
	                              ? "Converting ITT"
	                              : "Running OCR"
	                            : "Ready to run"}
	                      </h2>
                      {ocrRunStatus === "running" ? (
                        <div className="ocr-progress-panel">
                          {bridgeError ? <p>{bridgeError}</p> : null}
	                          <div
                            className="progress-meter"
                            role="progressbar"
                            aria-label={isIttTool ? "Conversion progress" : "OCR progress"}
                            aria-valuenow={ocrProgress}
                            aria-valuemin={0}
                            aria-valuemax={100}
                          >
                            <span style={{ width: `${ocrProgress}%` }} />
                          </div>
                          <p>
                            {ocrProgress}% complete
                            {ocrEtaSeconds ? ` · about ${ocrEtaSeconds}s left` : ""}
                          </p>
                        </div>
	                      ) : ocrRunStatus === "complete" ? (
                        <>
                          <div className="result-actions">
                            <button
                              className="primary"
                              type="button"
                              onClick={() => revealOutputs(visibleSrtFiles)}
                            >
                              Show SRT files
                            </button>
                            <button className="danger" type="button" onClick={resetBatch}>
                              Clear queue
                            </button>
                          </div>
                        </>
	                      ) : isIttTool ? (
	                        <>
	                          {/* A failed run returns to idle with the queue intact, so the
	                              reason has to be visible here as well as mid-run. */}
	                          {bridgeError ? <p className="error-text">{bridgeError}</p> : null}
	                          {validSelectedFps ? null : (
	                            <p>Choose a valid source FPS before converting.</p>
	                          )}
	                          <button disabled={!validSelectedFps} type="button" onClick={startBatch}>
	                            {bridgeError ? "Try conversion again" : "Run conversion"}
	                          </button>
	                        </>
	                      ) : selectedBatchLanguages.length ? (
	                        <>
	                          {bridgeError ? <p className="error-text">{bridgeError}</p> : null}
	                          <button type="button" onClick={startBatch}>
	                            {bridgeError ? "Try OCR again" : "Run OCR"}
	                          </button>
	                        </>
                      ) : (
                        <>
                          {bridgeError ? <p className="error-text">{bridgeError}</p> : null}
                          <p>
                            Choose at least one language before running OCR.
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                ) : null}

	                <article className="about-copy">
	                  <h2>Queue-driven conversion</h2>
	                  <p>
	                    {isIttTool
	                      ? "A single ITT file and a larger set follow the same path: add files, review jobs, choose the source frame rate, then convert."
	                      : "A single subtitle item and a larger set follow the same path: add files, review jobs, assign languages, then run OCR."}
	                  </p>
	                  {isIttTool ? (
	                    <>
	                      <h2>Frame-based timing</h2>
	                      <p>
	                        ITT files can use frame numbers in their timestamps.
	                        Pick the source frame rate so those cues land at the
	                        right SRT times.
	                      </p>
	                    </>
	                  ) : active === "subidx" ? (
	                    <>
                      <h2>SUB/IDX pairing</h2>
                      <p>
                        SUB and IDX files are matched by base file name when
                        several files are added at once.
                      </p>
                      <p>
                        For a single pair, the desktop workflow can also let you
                        confirm the match directly when filenames do not line up.
                      </p>
                    </>
                  ) : (
                    <>
                      <h2>PGS subtitle tracks</h2>
                      <p>
                        SUP files store rendered subtitle pictures. Conversion
                        extracts those images and uses OCR to rebuild an SRT.
                      </p>
                    </>
                  )}
	                  {isOcrTool ? (
	                    <>
	                      <h2>Language choices</h2>
	                      <p>
	                        If the exact language is missing, choose the closest OCR
	                        language that uses the same script. Mixed-language tracks
	                        may need a manual pass.
	                      </p>
	                    </>
	                  ) : null}
	                </article>
              </div>
          ) : null}

        </section>
      </section>
    </main>
  );
}
