function pad(value, size = 2) {
  return String(value).padStart(size, "0");
}

export function srtTime(seconds) {
  // Round the whole value to milliseconds first, then decompose. Truncating
  // the seconds and rounding the fraction separately can carry to 1000ms and
  // emit a four-digit field (00:00:05,1000) that no SRT parser accepts. The
  // `|| 0` guards a non-numeric input, which would otherwise yield NaN:NaN...
  const totalMillis = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

/**
 * Throws on an unusable value rather than quietly falling back to 23.976: a
 * silent default here shifts every frame-based cue in the file, which is very
 * hard to notice and impossible to distinguish from a bad source.
 */
export function parseFps(input = 23.976) {
  if (input === undefined || input === null || input === "") return 23.976;
  if (typeof input === "number") {
    if (Number.isFinite(input) && input > 0) return input;
    throw new Error(`Invalid frame rate: ${input}`);
  }

  const value = String(input).trim();
  const fraction = value.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/u);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (denominator > 0 && numerator > 0) return numerator / denominator;
    throw new Error(`Invalid frame rate: ${value}`);
  }

  const fps = Number(value);
  if (Number.isFinite(fps) && fps > 0) return fps;
  throw new Error(`Invalid frame rate: ${value}`);
}

/** Returns null when the input is not a timecode, so callers can react. */
function parseTimecode(input) {
  const match = String(input)
    .trim()
    // Hours are not capped at two digits: a 100h+ cue used to parse as 0 and
    // then get dropped by the end > start filter.
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/u);
  if (!match) return null;
  const [, hours = "0", minutes, seconds, fraction = "0"] = match;
  const millis = Number(fraction.padEnd(3, "0").slice(0, 3));
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    millis / 1000
  );
}

function requireTimecode(input, context) {
  const seconds = parseTimecode(input);
  if (seconds === null) {
    // Previously returned 0, so a malformed timecode became 00:00:00 and the
    // cue silently vanished with no diagnostic at all.
    throw new Error(`Unrecognized ${context} timecode: "${String(input).trim()}"`);
  }
  return seconds;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripXmlCdata(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1");
}

// Matches a tag even when an attribute value contains ">".
const anyTag = /<(?:[^>"']|"[^"]*"|'[^']*')*>/gu;
// Inline emphasis is meaningful subtitle content, not markup to discard.
const keptTag = /^<\/?(?:i|b|u)>$/iu;

export function cleanSubtitleText(text) {
  return decodeEntities(text)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\{\\.*?\}/g, "")
    .replace(anyTag, (tag) => (keptTag.test(tag) ? tag.toLowerCase() : ""))
    .replace(/\\[Nnh]/g, "\n")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function blocksToSrt(cues) {
  return cues
    .filter((cue) => cue.text.trim() && cue.end > cue.start)
    .map((cue, index) => {
      return [
        String(index + 1),
        `${srtTime(cue.start)} --> ${srtTime(cue.end)}`,
        cleanSubtitleText(cue.text),
      ].join("\n");
    })
    .join("\n\n")
    .concat("\n");
}

function normalizeSrt(source) {
  const cues = source
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .flatMap((block) => {
      const lines = block.split("\n").filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) return [];
      const [startRaw, endRaw] = lines[timingIndex].split("-->");
      return [
        {
          start: requireTimecode(startRaw, "start"),
          // .trim() first: without it the leading space after "-->" made
          // split(/\s+/)[0] an empty string, so end parsed as 0 and every cue
          // in the file was dropped. convertVtt below already did this.
          end: requireTimecode(endRaw.trim().split(/\s+/)[0], "end"),
          text: lines.slice(timingIndex + 1).join("\n"),
        },
      ];
    });

  return blocksToSrt(cues);
}

function convertVtt(source) {
  const body = source
    .replace(/\r/g, "")
    .replace(/^WEBVTT[^\n]*(?:\n|$)/i, "")
    .trim();
  const cues = body.split(/\n{2,}/).flatMap((block) => {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length || /^(NOTE|STYLE|REGION)\b/i.test(lines[0])) return [];
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return [];
    const [startRaw, endRaw] = lines[timingIndex].split("-->");
    return [
      {
        start: requireTimecode(startRaw.replace(".", ","), "start"),
        end: requireTimecode(endRaw.trim().split(/\s+/)[0].replace(".", ","), "end"),
        text: lines.slice(timingIndex + 1).join("\n"),
      },
    ];
  });
  return blocksToSrt(cues);
}

function splitAssDialogue(line, fieldCount) {
  let rest = line.replace(/^Dialogue:\s*/i, "");
  const parts = [];
  for (let index = 0; index < fieldCount - 1; index += 1) {
    const comma = rest.indexOf(",");
    if (comma < 0) break;
    parts.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  parts.push(rest);
  return parts;
}

function convertAss(source) {
  const lines = source.replace(/\r/g, "").split("\n");
  let fields = [
    "layer",
    "start",
    "end",
    "style",
    "name",
    "marginl",
    "marginr",
    "marginv",
    "effect",
    "text",
  ];

  const cues = lines.flatMap((line) => {
    if (/^Format:/i.test(line)) {
      fields = line
        .replace(/^Format:\s*/i, "")
        .split(",")
        .map((field) => field.trim().toLowerCase());
      return [];
    }
    if (!/^Dialogue:/i.test(line)) return [];
    const parts = splitAssDialogue(line, fields.length);
    const start = fields.indexOf("start");
    const end = fields.indexOf("end");
    const text = fields.indexOf("text");
    if (start < 0 || end < 0 || text < 0) return [];
    return [
      {
        start: requireTimecode(parts[start], "start"),
        end: requireTimecode(parts[end], "end"),
        text: parts.slice(text).join(","),
      },
    ];
  });

  return blocksToSrt(cues);
}

function convertMicroDvd(source, fps) {
  const cuePattern = /^\{(\d+)\}\{(\d+)\}(.*)$/gm;
  const cues = [];
  let match;
  let workingFps = fps;

  while ((match = cuePattern.exec(source))) {
    const startFrame = Number(match[1]);
    const endFrame = Number(match[2]);
    const text = match[3].replace(/\|/g, "\n");
    if (startFrame === 1 && endFrame === 1 && /^\d+(?:\.\d+)?$/.test(text)) {
      workingFps = Number(text);
      continue;
    }
    cues.push({
      start: startFrame / workingFps,
      end: endFrame / workingFps,
      text,
    });
  }

  return blocksToSrt(cues);
}

function convertMpl2(source) {
  const cues = Array.from(source.matchAll(/^\[(\d+)\]\[(\d+)\](.*)$/gm)).map(
    (match) => ({
      start: Number(match[1]) / 10,
      end: Number(match[2]) / 10,
      text: match[3].replace(/\|/g, "\n"),
    }),
  );
  return blocksToSrt(cues);
}

function parseXmlAttributes(source) {
  const attrs = {};
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function parseTtmlTime(input, fps) {
  const value = String(input || "").trim();
  const frameTime = value.match(/^(\d+):(\d{2}):(\d{2})[:;](\d+(?:\.\d+)?)$/u);
  if (frameTime) {
    return (
      Number(frameTime[1]) * 3600 +
      Number(frameTime[2]) * 60 +
      Number(frameTime[3]) +
      Number(frameTime[4]) / fps
    );
  }

  const clockTime = value.match(/^(\d+):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?$/u);
  if (clockTime) {
    const millis = Number((clockTime[4] ?? "0").padEnd(3, "0").slice(0, 3));
    return (
      Number(clockTime[1]) * 3600 +
      Number(clockTime[2]) * 60 +
      Number(clockTime[3]) +
      millis / 1000
    );
  }

  const offsetTime = value.match(/^(\d+(?:\.\d+)?)(h|m|s|ms|f)$/iu);
  if (offsetTime) {
    const amount = Number(offsetTime[1]);
    const unit = offsetTime[2].toLowerCase();
    if (unit === "h") return amount * 3600;
    if (unit === "m") return amount * 60;
    if (unit === "ms") return amount / 1000;
    if (unit === "f") return amount / fps;
    return amount;
  }

  // Bare seconds. `end` accepted these already, `begin` returned 0, so a cue
  // written as begin="1.5" end="3.5" started at zero.
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Number(value);

  return null;
}

/**
 * A TTML document declares its own frame rate. Ignoring it meant frame
 * timecodes were divided by whatever --fps happened to be, drifting every cue.
 */
function ittFrameRate(source, fallbackFps) {
  const root = source.match(/<(?:\w+:)?tt\b((?:[^>"']|"[^"]*"|'[^']*')*)>/iu);
  if (!root) return fallbackFps;
  const attrs = parseXmlAttributes(root[1]);
  const declared = Number(attrs["ttp:framerate"]);
  if (!Number.isFinite(declared) || declared <= 0) return fallbackFps;

  const multiplier = attrs["ttp:frameratemultiplier"];
  if (multiplier) {
    const [numerator, denominator] = String(multiplier).trim().split(/\s+/u).map(Number);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return declared * (numerator / denominator);
    }
  }
  return declared;
}

function convertItt(source, requestedFps) {
  const cues = [];
  const normalized = stripXmlCdata(source.replace(/\r/g, ""));
  const fps = ittFrameRate(normalized, requestedFps);
  // Attribute-aware: a value containing ">" (e.g. style="a>b") used to end the
  // tag early and leak markup into the cue text.
  const paragraphPattern =
    /<(?:\w+:)?p\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/(?:\w+:)?p>/giu;

  for (const match of normalized.matchAll(paragraphPattern)) {
    const attrs = parseXmlAttributes(match[1]);
    const begin = attrs.begin;
    const text = cleanSubtitleText(match[2]);
    if (!begin || !text) continue;

    const start = parseTtmlTime(begin, fps);
    if (start === null) continue;

    let stop = null;
    if (attrs.end !== undefined) {
      stop = parseTtmlTime(attrs.end, fps);
    } else if (attrs.dur !== undefined) {
      const duration = parseTtmlTime(attrs.dur, fps);
      stop = duration === null ? null : start + duration;
    }
    if (stop === null) continue;

    cues.push({ start, end: stop, text });
  }

  return blocksToSrt(cues);
}

function convertSmi(source) {
  const syncs = Array.from(
    source.matchAll(/<sync\s+start\s*=\s*"?(\d+)"?(?:[^>"']|"[^"]*"|'[^']*')*>/gi),
  );
  const cues = syncs.flatMap((match, index) => {
    const start = Number(match[1]) / 1000;
    const next = syncs[index + 1];
    const end = next ? Number(next[1]) / 1000 : start + 3;
    const raw = source.slice(match.index + match[0].length, next?.index);
    const text = cleanSubtitleText(raw);
    if (!text || /^&nbsp;$/i.test(text)) return [];
    return [{ start, end, text }];
  });
  return blocksToSrt(cues);
}

function convertTranscript(source) {
  const stamped = Array.from(
    source.matchAll(
      /^\s*(?:\[{1,2}|\()(\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)(?:\]{1,2}|\))\s*(.+)$/gm,
    ),
  );

  if (stamped.length) {
    const cues = stamped.map((match, index) => {
      const start = parseTimecode(match[1]);
      const next = stamped[index + 1];
      return {
        start,
        end: next ? parseTimecode(next[1]) : start + 4,
        text: match[2],
      };
    });
    return blocksToSrt(cues);
  }

  const lines = source
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const cues = lines.map((line, index) => ({
    start: index * 3.5,
    end: index * 3.5 + 3,
    text: line,
  }));
  return blocksToSrt(cues);
}

export function convertToSrt(source, fileName, options = {}) {
  const lowerName = String(fileName ?? "").toLowerCase();
  const normalized = source.replace(/\uFEFF/g, "");
  const fps = parseFps(options.fps ?? 23.976);

  // The file extension is authoritative when we have one. Content sniffing
  // only decides for files whose extension tells us nothing.
  if (lowerName.endsWith(".srt")) return normalizeSrt(normalized);
  if (lowerName.endsWith(".vtt")) return convertVtt(normalized);
  if (lowerName.endsWith(".itt") || lowerName.endsWith(".ttml")) {
    return convertItt(normalized, fps);
  }
  if (lowerName.endsWith(".ass") || lowerName.endsWith(".ssa")) {
    return convertAss(normalized);
  }
  if (lowerName.endsWith(".smi") || lowerName.endsWith(".sami")) {
    return convertSmi(normalized);
  }

  if (/^WEBVTT\b/i.test(normalized.trim())) return convertVtt(normalized);
  if (
    /<(?:(?:\w+:)?tt|tt)\b[^>]*(?:xmlns=["']http:\/\/www\.w3\.org\/ns\/ttml["']|http:\/\/www\.w3\.org\/ns\/ttml)/iu.test(
      normalized,
    )
  ) {
    return convertItt(normalized, fps);
  }
  if (/^\{\d+\}\{\d+\}/m.test(normalized)) {
    return convertMicroDvd(normalized, fps);
  }
  if (/^\[\d+\]\[\d+\]/m.test(normalized)) {
    return convertMpl2(normalized);
  }
  // Cue arrows are checked before [Events]/<sami, which are substrings that
  // can legitimately appear inside subtitle dialogue. Sniffing them first sent
  // an ordinary SRT to the ASS or SAMI parser, which returned zero cues.
  if (/-->/m.test(normalized)) {
    return normalizeSrt(normalized);
  }
  if (/^\s*\[Events\]/im.test(normalized)) {
    return convertAss(normalized);
  }
  if (/<sami\b/i.test(normalized)) {
    return convertSmi(normalized);
  }
  return convertTranscript(normalized);
}

/**
 * The one place SRT bytes are produced. The OCR path wrote BOM + CRLF while
 * the text path wrote bare LF with no BOM, so the same tool emitted two
 * different dialects depending on where the subtitles came from. BOM + CRLF
 * wins because it is what the OCR path already shipped and what players and
 * Windows editors handle most reliably.
 */
export function toSrtDocument(body) {
  const normalized = String(body ?? "").replace(/\r\n/gu, "\n");
  if (!normalized.trim()) return "\uFEFF";
  return `\uFEFF${normalized.replace(/\n/gu, "\r\n")}`;
}

export function outputNameFor(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const candidate = `${stem}.srt`;
  // An .srt input would otherwise map to its own name, and the conversion
  // would overwrite the file it was reading.
  return candidate === fileName ? `${stem}-converted.srt` : candidate;
}
