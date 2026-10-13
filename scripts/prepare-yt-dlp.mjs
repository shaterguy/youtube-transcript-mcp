// Bundle the pinned official Linux executable in Vercel's build environment.
// Termux uses its own locally installed Python yt-dlp module.
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const tag = "2026.08.19";
const sha256 = "58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a";
const expectedBytes = 40446224;
const destination = path.join(process.cwd(), "vendor", "yt-dlp_linux");
const checksum = (buffer) => createHash("sha256").update(buffer).digest("hex");

if (process.env.VERCEL !== "1" && process.env.YOUTUBE_BUNDLE_YT_DLP !== "1") {
  console.log("yt-dlp: skipping bundled Linux executable for local build.");
} else {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Bundled yt-dlp_linux requires Linux x64; do not package an incompatible binary.");
  }
  let cached = false;
  try {
    const existing = await readFile(destination);
    cached = existing.length === expectedBytes && checksum(existing) === sha256;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!cached) {
    const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp_linux`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`yt-dlp download rejected (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== expectedBytes || checksum(bytes) !== sha256) {
      throw new Error("yt-dlp download SHA-256/size mismatch; refusing to bundle unverified executable.");
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o755 });
      await chmod(temporary, 0o755);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  } else {
    await chmod(destination, 0o755);
  }
  console.log(`yt-dlp: verified ${tag}, sha256:${sha256}, ${expectedBytes} bytes.`);
}
