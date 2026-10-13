import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

type CaptionFormat = { ext?: string };
type VideoInfo = {
  language?: string;
  original_language?: string;
  audio_language?: string;
  duration?: number;
  subtitles?: Record<string, CaptionFormat[]>;
  automatic_captions?: Record<string, CaptionFormat[]>;
};

export type CaptionResult = { transcript: string; language: string; kind: "manual" | "automatic" };
export class YtDlpCaptionError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "YtDlpCaptionError";
  }
}

export function executor(): { binary: string; prefix: string[] } {
  const configured = process.env.YT_DLP_BIN?.trim();
  if (configured) return { binary: configured, prefix: [] };
  // The verified Linux asset is traced into the /mcp serverless function.
  if (process.env.VERCEL === "1") {
    return { binary: path.join(process.cwd(), "vendor", "yt-dlp_linux"), prefix: [] };
  }
  if ((process.env.PREFIX || "").includes("/com.termux/")) {
    return { binary: "python3", prefix: ["-m", "yt_dlp"] };
  }
  return { binary: "yt-dlp", prefix: [] };
}

async function runYtDlp(args: string[], timeoutMs = 55000): Promise<string> {
  const { binary, prefix } = executor();
  return new Promise<string>((resolve, reject) => {
    // Do not grant external yt-dlp access to Gemini credentials, job signing keys,
    // deployment tokens, or unrelated application secrets.
    const runtimeEnv: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
    for (const name of ["PATH","HOME","PREFIX","TMPDIR","LANG","LC_ALL",
      "PYTHONPATH","PYTHONHOME","SSL_CERT_FILE","SSL_CERT_DIR",
      "HTTPS_PROXY","HTTP_PROXY","NO_PROXY","LD_LIBRARY_PATH",
      "LD_PRELOAD","ANDROID_ROOT","ANDROID_DATA"]) {
      if (process.env[name] !== undefined) runtimeEnv[name] = process.env[name];
    }
    const child = spawn(binary, [...prefix, "--ignore-config", "--no-playlist", "--no-warnings", "--no-cache-dir",
      ...(process.env.VERCEL === "1" ? ["--js-runtimes", "node"] : []), ...args], {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: runtimeEnv,
    });
    let output = "";
    let errors = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new YtDlpCaptionError("yt-dlp caption request timed out.", "timeout"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => {
      output += value;
      if (output.length > 12_000_000) {
        child.kill("SIGKILL");
        fail(new YtDlpCaptionError("yt-dlp metadata output exceeds limit.", "oversize"));
      }
    });
    child.stderr.on("data", (value: string) => {
      errors = (errors + value).slice(-6000);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      fail(new YtDlpCaptionError(err.message, "executable_unavailable"));
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (status === 0) return resolve(output);
      const detail = errors.toLowerCase();
      const reason =
        /private video|video unavailable|sign in to confirm|age-restricted/.test(detail) ? "video_unavailable" :
        /http error 429|too many requests/.test(detail) ? "rate_limited" :
        /timed out|network|unable to download|http error|certificate/.test(detail) ? "network" : "yt_dlp_error";
      reject(new YtDlpCaptionError(errors.slice(-700) || "yt-dlp failed.", reason));
    });
  });
}

async function runWithRetries(args: string[], timeoutMs?: number): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await runYtDlp(args, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!(error instanceof YtDlpCaptionError) ||
          !["network", "rate_limited", "timeout"].includes(error.reason) ||
          attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2500));
    }
  }
  throw lastError;
}

function parseTimestamp(input: string): number | null {
  const parts = input.replace(",", ".").split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const last = parts.pop() || "";
  const min = Number(parts.pop());
  const hour = parts.length ? Number(parts.pop()) : 0;
  const seconds = Number(last);
  if (![hour, min, seconds].every(Number.isFinite) || min < 0 || min >= 60 ||
      seconds < 0 || seconds >= 60 || hour < 0) return null;
  return hour * 3600 + min * 60 + seconds;
}

function timecode(seconds: number): string {
  const whole = Math.floor(seconds);
  return [Math.floor(whole / 3600), Math.floor(whole % 3600 / 60), whole % 60]
    .map((n) => String(n).padStart(2, "0")).join(":");
}

export function normalizeSubtitle(input: string): { transcript: string; cues: number; lastSeconds: number } {
  const lines = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let current: { start: number; end: number; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join(" ").replace(/\s+/g, " ").trim();
    if (text && /[^\p{P}\p{S}\s\d]/u.test(text)) {
      cues.push({start: current.start, end: current.end, text});
    }
    current = null;
  };
  for (const raw of lines) {
    const match = /^\s*((?:(?:\d{1,2}:)?\d{2}:)?\d{2}[.,]\d{3})\s+-->\s+((?:(?:\d{1,2}:)?\d{2}:)?\d{2}[.,]\d{3})/.exec(raw);
    if (match) {
      flush();
      const start = parseTimestamp(match[1]);
      const end = parseTimestamp(match[2]);
      if (start !== null && end !== null && end >= start) current = {start, end, lines: []};
      continue;
    }
    if (!raw.trim()) { flush(); continue; }
    if (!current || /^(?:WEBVTT|NOTE|STYLE|REGION)\b/.test(raw.trim())) continue;
    const text = raw.replace(/<[^>]*>/g, "").replace(/\{\\an\d+\}/g, "")
      .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (value) =>
        ({ "&nbsp;":" ", "&amp;":"&", "&lt;":"<", "&gt;":">", "&quot;":'"', "&#39;":"'" }[value] ?? value)
      ).trim();
    if (text) current.lines.push(text);
  }
  flush();
  if (!cues.length) throw new YtDlpCaptionError("Captions contain no valid timed speech cues.", "invalid_captions");
  // Auto captions frequently repeat a rolling window at adjacent timestamps.
  // Remove ONLY adjacent overlapping renderings; preserve separately spoken repetitions.
  const merged: Array<{start:number;end:number;text:string}> = [];
  for (const cue of cues) {
    const prior = merged[merged.length - 1];
    if (!prior || cue.start - prior.end > 2.5) {
      merged.push({...cue});
      continue;
    }
    if (cue.start - prior.start > 25) {
      // Split long paragraphs while suppressing the same rolling caption
      // prefix across adjacent paragraph boundaries.
      const a = prior.text, b = cue.text;
      if (a.endsWith(b) && b.length >= 8) { prior.end = Math.max(prior.end, cue.end); continue; }
      let overlap = 0;
      for (let n = Math.min(a.length,b.length); n >= 8; n--) {
        if (a.slice(-n) === b.slice(0,n)) { overlap=n; break; }
      }
      const tail = b.slice(overlap).trim();
      if (tail) merged.push({...cue, text:tail});
      else prior.end = Math.max(prior.end,cue.end);
      continue;
    }
    const a = prior.text, b = cue.text;
    if (a.endsWith(b) && b.length >= 8) { prior.end = Math.max(prior.end, cue.end); continue; }
    if (b.startsWith(a) && a.length >= 8) { prior.text=b; prior.end=Math.max(prior.end,cue.end); continue; }
    let overlap = 0;
    for (let length=Math.min(a.length,b.length);length>=8;length--) {
      if (a.slice(-length) === b.slice(0,length)) { overlap=length; break; }
    }
    if (overlap >= 8) {
      prior.text = a + b.slice(overlap);
      prior.end = Math.max(prior.end, cue.end);
    } else {
      merged.push({...cue});
    }
  }
  const transcript = merged.map((cue) => "[" + timecode(cue.start) + "] " + cue.text).join("\n");
  return {transcript, cues:merged.length, lastSeconds:cues.reduce((end,cue)=>Math.max(end,cue.end),0)};
}

function chooseLanguages(info: VideoInfo, requested: string): Array<{ lang: string; kind: "manual" | "automatic" }> {
  const manual = info.subtitles || {};
  const automatic = info.automatic_captions || {};
  // Language tags come from third-party metadata, never pass arbitrary strings to CLI.
  const available = [...new Set([...Object.keys(manual), ...Object.keys(automatic)])]
    .filter((tag) => /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag));
  const preferred = [info.original_language, info.audio_language, info.language, requested]
    .filter((value): value is string => Boolean(value))
    .map((s) => s.toLowerCase().split("-")[0]);
  const choices: string[] = [];
  for (const prefix of preferred) {
    for (const name of available) if (name.toLowerCase() === prefix || name.toLowerCase().startsWith(prefix + "-")) {
      if (!choices.includes(name)) choices.push(name);
    }
  }
  for (const name of available) if (!choices.includes(name) && !name.endsWith("-orig")) choices.push(name);
  return choices.slice(0, 4).flatMap((lang) => {
    const result: Array<{ lang: string; kind: "manual" | "automatic" }> = [];
    if (Array.isArray(manual[lang]) && manual[lang].some((f) => f && (f.ext === "vtt" || f.ext === "srt"))) result.push({lang, kind:"manual"});
    if (Array.isArray(automatic[lang]) && automatic[lang].some((f) => f && (f.ext === "vtt" || f.ext === "srt"))) result.push({lang, kind:"automatic"});
    return result;
  });
}

export async function getYouTubeCaptionsWithYtDlp(videoId: string, requestedLanguage: string): Promise<CaptionResult> {
  const url = "https://www.youtube.com/watch?v=" + videoId;
  const info = JSON.parse(await runWithRetries(["--skip-download", "--dump-single-json", url])) as VideoInfo;
  const choices = chooseLanguages(info, requestedLanguage);
  if (!choices.length) throw new YtDlpCaptionError("No manual or autogenerated subtitles available.", "no_captions");
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ytcaptions-"));
  let lastFailure: Error | undefined;
  try {
    for (const {lang, kind} of choices) {
      const before = new Set(await fs.readdir(folder));
      try {
        await runWithRetries([
          "--skip-download", "--sub-langs", lang, "--sub-format", "vtt/srt",
          kind === "manual" ? "--write-subs" : "--write-auto-subs",
          "--no-write-info-json", "--no-write-thumbnail", "--no-write-playlist-metafiles",
          "-o", path.join(folder, "%(id)s.%(ext)s"), url
        ], 65000);
        const after = (await fs.readdir(folder)).filter((f) =>
          !before.has(f) && /\.(?:vtt|srt)$/i.test(f)
        );
        if (!after.length) throw new YtDlpCaptionError("yt-dlp produced no subtitle file.", "missing_file");
        for (const file of after) {
          const name = path.join(folder, file);
          const stat = await fs.stat(name);
          if (stat.size > 12_000_000) throw new YtDlpCaptionError("Subtitle file exceeds limit.", "oversize");
          const parsed = normalizeSubtitle(await fs.readFile(name, "utf8"));
          if (parsed.cues > 0) return {transcript:parsed.transcript, language:lang, kind};
        }
      } catch (error) {
        lastFailure = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastFailure ?? new YtDlpCaptionError("No usable timed captions found.", "invalid_captions");
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}
