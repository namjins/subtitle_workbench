function pad(value, size = 2) {
  return String(value).padStart(size, "0");
}

function srtTime(seconds) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

function parseTimecode(input) {
  const match = input.trim().match(
    /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/,
  );
  if (!match) return 0;
  const [, hours = "0", minutes, seconds, fraction = "0"] = match;
  const millis = Number(fraction.padEnd(3, "0").slice(0, 3));
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    millis / 1000
  );
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

export function cleanSubtitleText(text) {
  return decodeEntities(text)
    .replace(/\{\\.*?\}/g, "")
    .replace(/<[^>]*>/g, "")
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
          start: parseTimecode(startRaw),
          end: parseTimecode(endRaw.split(/\s+/)[0]),
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
        start: parseTimecode(startRaw.replace(".", ",")),
        end: parseTimecode(endRaw.trim().split(/\s+/)[0].replace(".", ",")),
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
        start: parseTimecode(parts[start]),
        end: parseTimecode(parts[end]),
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

function convertSmi(source) {
  const syncs = Array.from(
    source.matchAll(/<sync\s+start\s*=\s*"?(\d+)"?[^>]*>/gi),
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
  const lowerName = fileName.toLowerCase();
  const normalized = source.replace(/\uFEFF/g, "");
  const fps = Number(options.fps ?? 23.976);

  if (lowerName.endsWith(".vtt") || /^WEBVTT\b/i.test(normalized.trim())) {
    return convertVtt(normalized);
  }
  if (
    lowerName.endsWith(".ass") ||
    lowerName.endsWith(".ssa") ||
    /\[Events\]/i.test(normalized)
  ) {
    return convertAss(normalized);
  }
  if (lowerName.endsWith(".smi") || /<sami/i.test(normalized)) {
    return convertSmi(normalized);
  }
  if (/^\{\d+\}\{\d+\}/m.test(normalized)) {
    return convertMicroDvd(normalized, fps);
  }
  if (/^\[\d+\]\[\d+\]/m.test(normalized)) {
    return convertMpl2(normalized);
  }
  if (/-->/m.test(normalized)) {
    return normalizeSrt(normalized);
  }
  return convertTranscript(normalized);
}

export function outputNameFor(fileName) {
  return fileName.replace(/\.[^.]+$/, "") + ".srt";
}
