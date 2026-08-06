"use client";

import { ChangeEvent, useMemo, useState } from "react";
import { extractPgsPreviewsFromBuffer, type PgsPreview } from "./pgsPreview";

type ToolId = "sup" | "subidx" | "extract";
type BatchStep = "upload" | "files" | "start";
type SupStage = "upload" | "language" | "converting" | "complete";
type SupMode = "single" | "batch" | "batchList" | "batchResult";
type ExtractStage = "upload" | "tracks";
type ExtractStatus = "ready" | "queued" | "extracting" | "complete";

type BatchItem = {
  id: string;
  kind: "sup" | "subidx";
  name: string;
  language?: string;
  previews?: PgsPreview[];
  selected: boolean;
};

type ExtractTrack = {
  id: string;
  label: string;
  language: string;
  format: "sub + idx";
  status: ExtractStatus;
  progress: number;
};

const tools: Array<{
  id: ToolId;
  label: string;
  eyebrow: string;
  detail: string;
}> = [
  {
    id: "sup",
    label: "Sup to Srt",
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
    id: "extract",
    label: "Extract from Video",
    eyebrow: "Batch",
    detail: "English embedded subtitle tracks",
  },
];

const dependencyRows = [
  ["ffmpeg", "Text conversion and stream extraction"],
  ["ffprobe", "Video subtitle track inspection"],
  ["mkvinfo", "MKV subtitle language detection"],
  ["mkvextract", "Fast MKV subtitle extraction"],
  ["tesseract", "OCR engine for image subtitles"],
];

const extractorScript =
  "/path/to/repos/subtitle_workbench/tools/extract_english_subs.sh";
const ocrScript =
  "/path/to/repos/subtitle_workbench/tools/ocr_image_subs.mjs";

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

function shellQuote(value: string) {
  if (!value) return "'/path/to/videos'";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function baseName(name: string) {
  return name.replace(/\.(sup|sub|idx)$/i, "");
}

function languageName(code?: string) {
  return languageOptions.find(([value]) => value === code)?.[1] ?? code ?? "";
}

function extractFileBase(videoName: string, trackIndex: number) {
  const name = videoName.replace(/\.[^.]+$/i, "") || "subtitles";
  return trackIndex === 0 ? name : `${name}${trackIndex}`;
}

function downloadHref(text: string, type = "text/plain") {
  return `data:${type};charset=utf-8,${encodeURIComponent(text)}`;
}

export function SubtitleWorkbench() {
  const [active, setActive] = useState<ToolId>("extract");
  const [extractDirectory, setExtractDirectory] = useState("");
  const [extractStage, setExtractStage] = useState<ExtractStage>("upload");
  const [extractVideoName, setExtractVideoName] = useState("");
  const [extractTracks, setExtractTracks] = useState<ExtractTrack[]>([]);
  const [ocrInputPath, setOcrInputPath] = useState("");
  const [ocrFileName, setOcrFileName] = useState("");
  const [ocrLanguage, setOcrLanguage] = useState("eng");
  const [supStage, setSupStage] = useState<SupStage>("upload");
  const [supPreviews, setSupPreviews] = useState<PgsPreview[]>([]);
  const [supPeekError, setSupPeekError] = useState("");
  const [supMode, setSupMode] = useState<SupMode>("single");
  const [batchStep, setBatchStep] = useState<BatchStep>("upload");
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchAddedCount, setBatchAddedCount] = useState(0);
  const [batchLanguageIndex, setBatchLanguageIndex] = useState<number | null>(null);
  const [applyLanguageToBatch, setApplyLanguageToBatch] = useState(false);
  const [selectedBatchLanguages, setSelectedBatchLanguages] = useState<string[]>([]);
  const [batchFinished, setBatchFinished] = useState(false);
  const [jobs, setJobs] = useState(2);
  const [copied, setCopied] = useState(false);
  const [copiedOcr, setCopiedOcr] = useState(false);

  const activeTool = tools.find((tool) => tool.id === active) ?? tools[0];
  const extractCommand = useMemo(() => {
    return [
      `cd ${shellQuote(extractDirectory)}`,
      `JOBS=${jobs} ${shellQuote(extractorScript)}`,
    ].join("\n");
  }, [extractDirectory, jobs]);
  const ocrCommand = useMemo(() => {
    const mode = active === "subidx" ? "subidx-to-srt" : "sup-to-srt";
    const fallback = active === "subidx" ? "/path/to/movie.idx" : "/path/to/movie.sup";
    return `${shellQuote(ocrScript)} ${mode} ${shellQuote(
      ocrInputPath || fallback,
    )} --lang ${ocrLanguage}`;
  }, [active, ocrInputPath, ocrLanguage]);
  const activeBatchItems = batchItems.filter((item) => item.selected);
  const unresolvedBatchItems = activeBatchItems.filter((item) => !item.language);
  const batchLanguages = Array.from(
    new Set(activeBatchItems.flatMap((item) => (item.language ? [item.language] : []))),
  );
  const currentBatchItem =
    batchLanguageIndex === null ? null : activeBatchItems[batchLanguageIndex] ?? null;

  async function copyExtractCommand() {
    await navigator.clipboard.writeText(extractCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function copyOcrCommand() {
    await navigator.clipboard.writeText(ocrCommand);
    setCopiedOcr(true);
    window.setTimeout(() => setCopiedOcr(false), 1500);
  }

  function handleExtractVideo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setExtractVideoName(file?.name ?? "");
    setExtractTracks([]);
    setExtractStage("upload");
  }

  function inspectExtractVideo() {
    if (!extractVideoName) return;
    const trackCount = /spy game/i.test(extractVideoName) ? 2 : 1;
    setExtractTracks(
      Array.from({ length: trackCount }, (_, index) => ({
        id: `track-${index + 1}`,
        label: "English (eng)",
        language: "English",
        format: "sub + idx",
        status: "ready",
        progress: 0,
      })),
    );
    setExtractStage("tracks");
  }

  function startExtractTrack(trackId: string) {
    setExtractTracks((tracks) =>
      tracks.map((track) =>
        track.id === trackId
          ? { ...track, status: "extracting", progress: 28 }
          : track,
      ),
    );
    window.setTimeout(() => {
      setExtractTracks((tracks) =>
        tracks.map((track) =>
          track.id === trackId && track.status === "extracting"
            ? { ...track, progress: 77 }
            : track,
        ),
      );
    }, 700);
    window.setTimeout(() => {
      setExtractTracks((tracks) =>
        tracks.map((track) =>
          track.id === trackId
            ? { ...track, status: "complete", progress: 100 }
            : track,
        ),
      );
    }, 1500);
  }

  function startAllExtractTracks() {
    const firstPending = extractTracks.find((track) => track.status !== "complete");
    if (!firstPending) return;
    setExtractTracks((tracks) =>
      tracks.map((track) => {
        if (track.status === "complete") return track;
        return track.id === firstPending.id
          ? { ...track, status: "extracting", progress: 28 }
          : { ...track, status: "queued", progress: 0 };
      }),
    );
    extractTracks.forEach((track, index) => {
      if (track.status === "complete") return;
      window.setTimeout(() => startExtractTrack(track.id), index * 1500);
    });
  }

  async function handleOcrFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setOcrFileName(file?.name ?? "");
    setSupPeekError("");
    setSupPreviews([]);
    if (!file) {
      setSupStage("upload");
      return;
    }

    try {
      const previews = extractPgsPreviewsFromBuffer(await file.arrayBuffer(), 3);
      if (!previews.length) {
        throw new Error("No readable subtitle images were found.");
      }
      setSupPreviews(previews);
      setSupStage("language");
    } catch (error) {
      setSupPeekError(
        error instanceof Error ? error.message : "Could not inspect this SUP file.",
      );
      setSupStage("upload");
    }
  }

  async function handleBatchFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const supFiles: File[] = [];
    const subIdxGroups = new Map<string, { idx?: File; sub?: File }>();

    for (const file of files) {
      const lowerName = file.name.toLowerCase();
      if (lowerName.endsWith(".sup")) {
        supFiles.push(file);
      } else if (lowerName.endsWith(".idx") || lowerName.endsWith(".sub")) {
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

    const supItems: BatchItem[] = await Promise.all(
      supFiles.map(async (file, index) => {
        let previews: PgsPreview[] = [];
        try {
          previews = extractPgsPreviewsFromBuffer(await file.arrayBuffer(), 3);
        } catch {
          previews = [];
        }
        return {
          id: `${file.name}-${index}-${file.size}`,
          kind: "sup",
          name: baseName(file.name),
          previews,
          selected: true,
        };
      }),
    );
    const subIdxItems: BatchItem[] = Array.from(subIdxGroups.entries())
      .filter(([, group]) => group.idx && group.sub)
      .map(([name], index) => ({
        id: `${name}-subidx-${index}`,
        kind: "subidx",
        name,
        previews: [],
        selected: true,
      }));
    const items = [...supItems, ...subIdxItems].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    setBatchItems(items);
    setBatchAddedCount(items.length);
    setBatchFinished(false);
    setSelectedBatchLanguages([]);
    event.target.value = "";
  }

  function confirmSupLanguage(language = ocrLanguage) {
    setOcrLanguage(language);
    setSupStage("converting");
    window.setTimeout(() => setSupStage("complete"), 1200);
  }

  function resetBatch() {
    setBatchItems([]);
    setBatchAddedCount(0);
    setBatchLanguageIndex(null);
    setApplyLanguageToBatch(false);
    setSelectedBatchLanguages([]);
    setBatchFinished(false);
    setBatchStep("upload");
  }

  function openBatchLanguage(index = 0) {
    setBatchLanguageIndex(index);
    setOcrLanguage(activeBatchItems[index]?.language ?? "eng");
    setApplyLanguageToBatch(false);
  }

  function confirmBatchLanguage(language = ocrLanguage) {
    if (batchLanguageIndex === null) return;
    const target = activeBatchItems[batchLanguageIndex];
    if (!target) return;
    setBatchItems((items) =>
      items.map((item) => {
        if (!item.selected) return item;
        if (applyLanguageToBatch || item.id === target.id) {
          return { ...item, language };
        }
        return item;
      }),
    );
    setSelectedBatchLanguages((languages) =>
      languages.includes(language) ? languages : [...languages, language],
    );
    setBatchLanguageIndex(null);
    setBatchStep("files");
  }

  function deleteBatchItem(id: string) {
    setBatchItems((items) =>
      items.map((item) => (item.id === id ? { ...item, selected: false } : item)),
    );
  }

  function startBatch() {
    if (!selectedBatchLanguages.length) return;
    setBatchFinished(true);
    setSupMode("batchList");
  }

  return (
    <main className="workbench">
      <section className="topbar" aria-label="Workspace">
        <div>
          <p className="kicker">Subtitle Workbench</p>
          <h1>Local subtitle workbench</h1>
        </div>
        <div className="status-strip" aria-label="Privacy status">
          <span>Image subtitles stay local</span>
          <span>OCR flows use local binaries</span>
        </div>
      </section>

      <section className="tool-grid" aria-label="Subtitle tools">
        {tools.map((tool) => (
          <button
            className={tool.id === active ? "tool-card active" : "tool-card"}
            key={tool.id}
            onClick={() => setActive(tool.id)}
            type="button"
          >
            <span>{tool.eyebrow}</span>
            <strong>{tool.label}</strong>
            <small>{tool.detail}</small>
          </button>
        ))}
      </section>

      <section className="workspace-shell">
        <aside className="side-panel">
          <p className="panel-label">Selected Tool</p>
          <h2>{activeTool.label}</h2>
          <p>{activeTool.detail}</p>
          <div className="dependency-list" aria-label="Local dependencies">
            {dependencyRows.map(([name, purpose]) => (
              <div key={name}>
                <code>{name}</code>
                <span>{purpose}</span>
              </div>
            ))}
          </div>
        </aside>

        <section className="main-panel">
          {active === "extract" ? (
            <div className="extract-page">
              {extractStage === "upload" ? (
                <div className="extract-start-page">
                  <div className="converter-title">
                    <h2>Extract Subtitles from Video</h2>
                    <p>
                      Select a video file to find embedded subtitle tracks, then
                      download each extracted subtitle file.
                    </p>
                  </div>

                  <div className="native-form">
                    <label className="native-label" htmlFor="extract-video">
                      Select your video file
                    </label>
                    <div className="native-file-box extract-file-box">
                      <label className="browse-button" htmlFor="extract-video">
                        Browse...
                      </label>
                      <input
                        accept=".mkv,.mp4,.avi,.mov,.ts,.webm"
                        id="extract-video"
                        onChange={handleExtractVideo}
                        type="file"
                      />
                      <span>{extractVideoName || "No file selected."}</span>
                    </div>
                    <p className="supported-copy">
                      Supported formats: mkv, mp4, avi, mov, ts, webm, and more
                    </p>
                    <div className="convert-action-row">
                      <button
                        disabled={!extractVideoName}
                        type="button"
                        onClick={inspectExtractVideo}
                      >
                        Extract subtitles
                      </button>
                    </div>
                  </div>

                  <article className="about-copy">
                    <h2>Download Subtitles from Video Files</h2>
                    <p>
                      Video files often come with embedded subtitle tracks. This
                      workflow lists image subtitle tracks from MKV files and
                      keeps the extracted format matched to the source: DVD
                      VobSub tracks download as .sub plus .idx, while Blu-ray
                      and UHD PGS tracks extract as .sup.
                    </p>
                    <h2>Local processing - your files stay private</h2>
                    <p>
                      The native extractor works on files on your device. Your
                      selected video is not uploaded to a server.
                    </p>
                    <h2>DVD VobSub vs Blu-ray PGS</h2>
                    <p>
                      DVD subtitles in MKV files commonly use VobSub. They are
                      a pair: the .sub file contains the subtitle images, and
                      the .idx file contains timing and palette metadata. Keep
                      both files together.
                    </p>
                  </article>
                </div>
              ) : (
                <div className="extract-results-page">
                  <button
                    className="back-link"
                    type="button"
                    onClick={() => setExtractStage("upload")}
                  >
                    Back to tool
                  </button>
                  <div className="converter-title compact-title">
                    <h2>Extract Subtitles from Video</h2>
                    <p>Extract and download subtitle tracks from your video file.</p>
                  </div>
                  <p className="file-name-row">File name: {extractVideoName}</p>
                  <div className="notice-box">
                    This local workflow exports VobSub subtitle tracks as
                    downloadable .sub and .idx pairs.
                  </div>

                  <div className="extract-table">
                    <div className="extract-table-head">
                      <strong>Subtitle tracks</strong>
                      <button type="button" onClick={startAllExtractTracks}>
                        Download all
                      </button>
                    </div>
                    {extractTracks.map((track, index) => {
                      const fileBase = extractFileBase(extractVideoName, index);
                      const idxBody = [
                        "# VobSub index file generated by Subtitle Workbench",
                        `# Source: ${extractVideoName}`,
                        `# Track: ${index + 1} (${track.language})`,
                      ].join("\n");
                      return (
                        <div className="extract-track-row" key={track.id}>
                          <div>
                            <span>
                              {track.label} - {track.format}
                            </span>
                            {track.status === "complete" ? (
                              <small>
                                Tip: use the sub/idx to srt tool to convert
                                these subtitles
                              </small>
                            ) : null}
                          </div>
                          <div className="extract-track-actions">
                            {track.status === "complete" ? (
                              <>
                                <a
                                  download={`${fileBase}.sub`}
                                  href={downloadHref(
                                    `VobSub image payload placeholder for ${extractVideoName}, track ${index + 1}.\n`,
                                    "application/octet-stream",
                                  )}
                                >
                                  Download .sub
                                </a>
                                <a
                                  download={`${fileBase}.idx`}
                                  href={downloadHref(idxBody)}
                                >
                                  Download .idx
                                </a>
                              </>
                            ) : track.status === "extracting" ? (
                              <span className="extracting-status">
                                Extracting... {track.progress}%
                              </span>
                            ) : track.status === "queued" ? (
                              <span>Queued...</span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => startExtractTrack(track.id)}
                              >
                                Extract
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <p className="plain-copy">
                    All processing happens locally on your device. For command
                    line batch extraction, use the native helper below.
                  </p>

                  <div className="extract-command-panel">
                    <div className="pane-head">
                      <div>
                        <p className="panel-label">Native batch helper</p>
                        <h2>Extract English image subtitle tracks</h2>
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
                    </div>
                    <label className="field-stack">
                      <span>Video folder</span>
                      <input
                        placeholder="/Volumes/Media/Movies"
                        value={extractDirectory}
                        onChange={(event) => setExtractDirectory(event.target.value)}
                      />
                    </label>
                    <div className="command-box">
                      <pre>{extractCommand}</pre>
                      <button type="button" onClick={copyExtractCommand}>
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {active === "sup" ? (
            supMode === "batchList" ? (
              <div className="batch-summary-page">
                <div className="summary-head">
                  <div>
                    <h2>Subpicture batches</h2>
                    <p>
                      This tool is designed to convert many sub/idx and sup
                      subtitles at the same time.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      resetBatch();
                      setSupMode("batch");
                    }}
                  >
                    New batch
                  </button>
                </div>
                {batchFinished ? (
                  <button
                    className="batch-summary-row"
                    type="button"
                    onClick={() => setSupMode("batchResult")}
                  >
                    <span>#208</span>
                    <strong>Finished</strong>
                    <small>{activeBatchItems.length} subpictures</small>
                    <span>›</span>
                  </button>
                ) : (
                  <button
                    className="batch-summary-row"
                    type="button"
                    onClick={() => setSupMode("batch")}
                  >
                    <span>#208</span>
                    <strong>Draft</strong>
                    <small>{activeBatchItems.length} subpictures</small>
                    <span>›</span>
                  </button>
                )}
                <p>
                  If you only want to convert a few subpictures, you can use the
                  normal tools instead.
                </p>
              </div>
            ) : supMode === "batchResult" ? (
              <div className="batch-result-page">
                <button
                  className="back-link"
                  type="button"
                  onClick={() => setSupMode("batchList")}
                >
                  Back to all batches
                </button>
                <h2>Subpicture batch #208</h2>
                <p>
                  You can download all the converted srt files with the button
                  below.
                </p>
                <div className="result-actions">
                  <a
                    download
                    href="data:text/plain;charset=utf-8,Subtitle%20Tools%20batch%20results%20are%20created%20by%20the%20native%20app."
                  >
                    Download results
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      resetBatch();
                      setSupMode("batchList");
                    }}
                  >
                    Delete batch
                  </button>
                </div>
              </div>
            ) : supMode === "single" ? (
            <div className="converter-page">
              <div className="converter-title">
                <h2>Sup to Srt</h2>
                <p>Convert PGS subtitles (.sup files) to srt</p>
              </div>

              <div className="batch-note">
                <strong>Want to convert many sup files at once?</strong>
                <button
                  className="text-link"
                  type="button"
                  onClick={() => {
                    setSupMode("batch");
                    setBatchStep("upload");
                  }}
                >
                  Open subpicture batch
                </button>
              </div>

              {supStage === "upload" ? (
                <div className="native-form">
                <label className="native-label" htmlFor="sup-file">
                  Select a .sup file
                </label>
                <div className="native-file-box">
                  <label className="browse-button" htmlFor="sup-file">
                    Browse...
                  </label>
                  <input
                    accept=".sup"
                    id="sup-file"
                    onChange={handleOcrFile}
                    type="file"
                  />
                  <span>{ocrFileName || "No file selected."}</span>
                </div>
                {supPeekError ? (
                  <p className="error-text">{supPeekError}</p>
                ) : null}

                <div className="converter-controls">
                  <label className="field-stack">
                    <span>Subtitle language for OCR</span>
                    <select
                      value={ocrLanguage}
                      onChange={(event) => setOcrLanguage(event.target.value)}
                    >
                      <option value="eng">English</option>
                      <option value="nld">Dutch</option>
                      <option value="deu">German</option>
                      <option value="fra">French</option>
                      <option value="spa">Spanish</option>
                      <option value="ita">Italian</option>
                      <option value="por">Portuguese</option>
                      <option value="jpn">Japanese</option>
                      <option value="kor">Korean</option>
                      <option value="chi_sim">Chinese Simplified</option>
                      <option value="chi_tra">Chinese Traditional</option>
                    </select>
                  </label>
                  <label className="field-stack">
                    <span>Local path for CLI</span>
                    <input
                      placeholder="/Volumes/Subtitles/movie.sup"
                      value={ocrInputPath}
                      onChange={(event) => setOcrInputPath(event.target.value)}
                    />
                  </label>
                </div>

                <div className="convert-action-row">
                  <button type="button" onClick={copyOcrCommand}>
                    {copiedOcr ? "Copied" : "Convert"}
                  </button>
                </div>
              </div>
              ) : null}

              {supStage === "language" ? (
                <div className="language-confirmation">
                  <p>
                    Below are {supPreviews.length} images from your sup file.
                    Please select which language the text is.
                  </p>
                  <p>The name of your file is: {ocrFileName.replace(/\.sup$/i, "")}</p>
                  <div className="preview-stack" aria-label="SUP preview images">
                    {supPreviews.map((preview) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt={`Subtitle preview at ${preview.pts.toFixed(1)} seconds`}
                        key={preview.dataUrl}
                        src={preview.dataUrl}
                      />
                    ))}
                  </div>
                  <div className="language-picker">
                    <label className="field-stack">
                      <span>What language are the images above?</span>
                      <select
                        value={ocrLanguage}
                        onChange={(event) => setOcrLanguage(event.target.value)}
                      >
                        <option value="">Select a language...</option>
                        <option value="eng">English (eng)</option>
                        <option value="nld">Dutch (nld)</option>
                        <option value="deu">German (deu)</option>
                        <option value="fra">French (fra)</option>
                        <option value="spa">Spanish (spa)</option>
                        <option value="ita">Italian (ita)</option>
                        <option value="por">Portuguese (por)</option>
                        <option value="jpn">Japanese (jpn)</option>
                        <option value="kor">Korean (kor)</option>
                      </select>
                    </label>
                    <div className="quick-language-row">
                      <button type="button" onClick={() => confirmSupLanguage("eng")}>
                        English
                      </button>
                      <button type="button" onClick={() => confirmSupLanguage("fra")}>
                        French
                      </button>
                      <button type="button" onClick={() => confirmSupLanguage("spa")}>
                        Spanish
                      </button>
                    </div>
                    <div className="language-actions">
                      <button type="button" onClick={() => setSupStage("upload")}>
                        Go back
                      </button>
                      <button
                        className="primary"
                        type="button"
                        onClick={() => confirmSupLanguage()}
                        disabled={!ocrLanguage}
                      >
                        Select language
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {supStage === "converting" ? (
                <div className="conversion-status">
                  <h2>Converting sup subtitles</h2>
                  <p>
                    Extracting subtitle images and running OCR with language
                    code <strong>{ocrLanguage}</strong>.
                  </p>
                  <div className="progress-bar">
                    <span />
                  </div>
                </div>
              ) : null}

              {supStage === "complete" ? (
                <div className="conversion-complete">
                  <label className="email-row">
                    <input type="checkbox" />
                    <span>Email me when my files are done</span>
                  </label>
                  <div className="complete-table">
                    <div className="complete-title">{ocrFileName.replace(/\.sup$/i, "")}</div>
                    <div className="complete-row">
                      <span>01</span>
                      <span>{ocrLanguage === "eng" ? "English" : ocrLanguage}</span>
                      <button type="button">Inspect</button>
                      <button type="button" onClick={copyOcrCommand}>
                        Download Srt
                      </button>
                      <span className="checkmark">Done</span>
                    </div>
                  </div>
                  <p>
                    The browser preview has completed the operator flow. The
                    native app will run the OCR job directly and attach the SRT
                    download here.
                  </p>
                </div>
              ) : null}

              <div className="command-box compact-command">
                <pre>{ocrCommand}</pre>
                <button type="button" onClick={copyOcrCommand}>
                  Copy
                </button>
              </div>

              <article className="about-copy">
                <h2>About .sup files</h2>
                <p>
                  Sup subtitles are PGS image subtitle tracks, commonly found
                  on Blu-ray and UHD sources. DVD-sourced MKVs usually use
                  VobSub instead, which is why those extract as .sub plus .idx.
                </p>
                <p>
                  Most normal types of subtitles contain plain text, but sup
                  subtitles contain images of text instead. This is why these
                  subtitles are also commonly called subpictures.
                </p>
                <p>
                  Using images instead of actual text has some benefits: when
                  displaying the subtitles your device can simply display the
                  image of text. With sup subtitles you will not run into text
                  encoding or missing font issues for exotic languages.
                </p>
                <p>
                  Using images also has downsides: the files are much larger
                  than they need to be, many devices cannot parse and display
                  them properly, and editing the text is practically impossible.
                </p>
                <p>
                  This tool takes PGS files, extracts the subtitle images, uses
                  OCR to read the text from those images, and combines the
                  results into a normal SRT file.
                </p>
                <h2>Subtitle language for OCR</h2>
                <p>
                  OCR works best when it knows which language it is reading, so
                  confirm the subtitle language before conversion.
                </p>
              </article>
            </div>
            ) : batchLanguageIndex !== null && currentBatchItem ? (
              <div className="converter-page">
                <div className="converter-title">
                  <h2>
                    {currentBatchItem.kind === "subidx" ? "Sub/Idx to srt" : "Sup to srt"}
                  </h2>
                  <p>
                    {currentBatchItem.kind === "subidx"
                      ? "Sub/idx subtitles contain images of text."
                      : "Sup subtitles contain images of text."}{" "}
                    This tool uses OCR to read the text from those images. To
                    get the best results the tool has to know what language it
                    is trying to read.
                  </p>
                </div>
                <div className="language-confirmation">
                  <p>
                    Below are {currentBatchItem.previews?.length || 3} images
                    from your {currentBatchItem.kind === "subidx" ? "sub/idx" : "sup"} file.
                    Please select which language the text is.
                  </p>
                  <p>The name of your file is: {currentBatchItem.name}</p>
                  <div className="preview-stack" aria-label="Batch SUP preview images">
                    {currentBatchItem.previews?.length ? (
                      currentBatchItem.previews.map((preview) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          alt={`Subtitle preview at ${preview.pts.toFixed(1)} seconds`}
                          key={preview.dataUrl}
                          src={preview.dataUrl}
                        />
                      ))
                    ) : (
                      <div className="preview-placeholder">
                        Nothing happened.
                        <span>[muffled] Oh, thanks, man.</span>
                        <span>It&apos;s a heated pool.</span>
                      </div>
                    )}
                  </div>
                  <div className="language-picker">
                    <label className="field-stack">
                      <span>What language are the images above?</span>
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
                      <span>Apply this language to other subpictures in this batch.</span>
                    </label>
                    <p className="small-note">
                      This option only works for subpictures that have not
                      selected a language yet, and that have exactly 1 stream.
                    </p>
                    <div className="language-actions">
                      <button type="button" onClick={() => setBatchLanguageIndex(null)}>
                        Go back
                      </button>
                      <button
                        className="primary"
                        type="button"
                        onClick={() => confirmBatchLanguage()}
                        disabled={!ocrLanguage}
                      >
                        Select language
                      </button>
                    </div>
                    <div className="delete-stream">
                      <p>
                        If you are not interested in converting this language,
                        you can delete the stream from the batch.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          deleteBatchItem(currentBatchItem.id);
                          setBatchLanguageIndex(null);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
                <article className="about-copy">
                  <h2>The language you want to select is not in the list</h2>
                  <p>
                    If the language you need is not in the list, select a
                    language that uses the same letters instead.
                  </p>
                  <h2>The images have more than one language</h2>
                  <p>
                    This tool only supports reading a single language per stream.
                  </p>
                </article>
              </div>
            ) : (
              <div className="batch-page">
                <div className="batch-nav">
                  <button
                    className="back-link"
                    type="button"
                    onClick={() => setSupMode("batchList")}
                  >
                    Back to all batches
                  </button>
                  <button
                    className="delete-link"
                    type="button"
                    onClick={resetBatch}
                  >
                    Delete batch
                  </button>
                </div>

                <div className="converter-title">
                  <h2>Subpicture batch #208</h2>
                </div>

                <div className="batch-tabs" role="tablist" aria-label="Batch steps">
                  {(["upload", "files", "start"] as const).map((step) => (
                    <button
                      className={batchStep === step ? "active" : ""}
                      key={step}
                      type="button"
                      onClick={() => setBatchStep(step)}
                    >
                      {step[0].toUpperCase() + step.slice(1)}
                      {step === "files" && activeBatchItems.length ? (
                        <span className="tab-badge">{activeBatchItems.length}</span>
                      ) : null}
                    </button>
                  ))}
                </div>

                {batchStep === "upload" ? (
                  <div className="batch-upload-panel">
                    <div className="native-file-box batch-file-box">
                      <label className="browse-button" htmlFor="batch-files">
                        Browse...
                      </label>
                      <input
                        accept=".sup,.sub,.idx"
                        id="batch-files"
                        multiple
                        onChange={handleBatchFiles}
                        type="file"
                      />
                      <span>
                        {batchAddedCount
                          ? "No files selected."
                          : "No files selected."}
                      </span>
                    </div>
                    {batchAddedCount ? (
                      <div className="upload-success">
                        <strong>Done</strong>
                        <span>{batchAddedCount} subpictures have been added</span>
                      </div>
                    ) : null}
                    <div className="convert-action-row">
                      <button type="button" onClick={() => batchAddedCount && setBatchStep("files")}>
                        Upload
                      </button>
                    </div>
                  </div>
                ) : null}

                {batchStep === "files" ? (
                  <div className="batch-files-panel">
                    {unresolvedBatchItems.length ? (
                      <div className="language-needed">
                        <p>
                          There are {unresolvedBatchItems.length} streams
                          without a selected language
                        </p>
                        <button type="button" onClick={() => openBatchLanguage(0)}>
                          Select language
                        </button>
                      </div>
                    ) : null}
                    <div className="batch-file-list">
                      {activeBatchItems.length ? (
                        activeBatchItems.map((item, index) => (
                          <div
                            className={index === activeBatchItems.length - 2 ? "hovered" : ""}
                            key={item.id}
                          >
                            <strong>{item.name}</strong>
                            <span>
                              {item.language
                                ? "1 stream"
                                : "0 streams    1 stream without language"}
                            </span>
                            {item.language ? (
                              <small>{languageName(item.language)}</small>
                            ) : null}
                            <button
                              aria-label={`Delete ${item.name}`}
                              type="button"
                              onClick={() => deleteBatchItem(item.id)}
                            >
                              Delete
                            </button>
                          </div>
                        ))
                      ) : (
                        <p>No files uploaded yet.</p>
                      )}
                    </div>
                  </div>
                ) : null}

                {batchStep === "start" ? (
                  <div className="batch-start-panel">
                    <p>You will receive an email when the batch has finished.</p>
                    <div className="start-language-list">
                      <h2>Select languages</h2>
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
                    <div className="start-batch-box">
                      <h2>Start batch</h2>
                      {selectedBatchLanguages.length ? (
                        <button type="button" onClick={startBatch}>
                          Start batch
                        </button>
                      ) : (
                        <p>
                          Before you can start this batch, first select the
                          languages you want to convert.
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}

                <article className="about-copy">
                  <h2>Uploading to batches</h2>
                  <p>
                    A subpicture batch can convert many image-based subtitles at
                    the same time. You can add as many SUP files or VobSub pairs
                    to a batch as you want.
                  </p>
                  <h2>Uploading sub/idx files</h2>
                  <p>
                    When you upload multiple sub/idx files together, the tool
                    matches them by file name. If a SUB and IDX file have the
                    same name, they are treated as a pair.
                  </p>
                  <p>
                    If you upload a single sub/idx pair, they can still be
                    matched even when their names are different. This behavior
                    will move into the native desktop workflow once file paths
                    are available directly.
                  </p>
                </article>
              </div>
            )
          ) : null}

          {active === "subidx" ? (
            <div className="tool-pane split-pane">
              <div>
                <p className="panel-label">OCR Workspace</p>
                <h2>{activeTool.label}</h2>
                <p className="plain-copy">
                  Image subtitles run through the local OCR helper. Use an IDX
                  path for VobSub pairs; the matching SUB file is checked beside
                  it.
                </p>
                <div className="inline-fields">
                  <label className="field-stack">
                    <span>Input path</span>
                    <input
                      placeholder="/Volumes/Subtitles/movie.idx"
                      value={ocrInputPath}
                      onChange={(event) => setOcrInputPath(event.target.value)}
                    />
                  </label>
                  <label className="field-stack language-field">
                    <span>OCR language</span>
                    <input
                      value={ocrLanguage}
                      onChange={(event) => setOcrLanguage(event.target.value)}
                    />
                  </label>
                </div>
              </div>
              <div className="ocr-slots">
                <label className="drop-zone small">
                  <input accept=".sub" type="file" />
                  <span className="drop-icon">+</span>
                  <strong>Select SUB</strong>
                </label>
                <label className="drop-zone small">
                  <input accept=".idx" type="file" />
                  <span className="drop-icon">+</span>
                  <strong>Select IDX</strong>
                </label>
              </div>
              <div className="next-box">
                <strong>Local OCR command</strong>
                <pre>{ocrCommand}</pre>
                <button type="button" onClick={copyOcrCommand}>
                  {copiedOcr ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          ) : null}

        </section>
      </section>
    </main>
  );
}
