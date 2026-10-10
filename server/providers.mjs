import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import sharp from "sharp";
import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  selectComposition,
  makeCancelSignal,
} from "@remotion/renderer";
import { run } from "./process.mjs";
import { dir, atomic } from "./store.mjs";
import {
  projectSchema,
  shotSchema,
  totalFrames,
  FPS,
  qualityIssues,
} from "../shared/model.mjs";
export const hash = (...values) =>
  crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
const imagegenCommand =
  process.env.HISTORY_IMAGEGEN_CLI ||
  path.join(os.homedir(), ".local/bin/imagegen-cli");
const exists = async (f) => !!(await fs.stat(f).catch(() => null));
export async function diagnostics() {
  const commands = [
    ["codex", "Codex研究"],
    [imagegenCommand, "GPT-Image-2图像"],
    ["ffmpeg", "音频与视频"],
    ["ffprobe", "媒体检查"],
    ["say", "Mac中文旁白"],
  ];
  return Promise.all(
    commands.map(async ([command, label]) => {
      try {
        await run("/usr/bin/which", [command], { timeout: 5000 });
        return { command, label, available: true };
      } catch {
        return { command, label, available: false };
      }
    }),
  );
}
export async function research(p, ctx) {
  const base = dir(p.id);
  const template = await fs.readFile("prompts/research.txt", "utf8");
  const target = path.join(base, "research-result.json");
  await fs.mkdir(base, { recursive: true });
  await run(
    "codex",
    [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "-c",
      'web_search="live"',
      "--output-schema",
      path.resolve("prompts/research.schema.json"),
      "-o",
      target,
      ...p.referenceImages.flatMap((ref) => ["--image", path.join(base, ref)]),
      "-",
    ],
    {
      cwd: base,
      input:
        template +
        "\n研究输入：" +
        JSON.stringify({
          topic: p.topic,
          type: p.type,
          focus: p.focus,
          officialUrls: p.officialUrls,
        }),
      signal: ctx.signal,
      timeout: 900000,
    },
  );
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    throw new Error("研究结果不是有效JSON，已保留结果供检查");
  }
  if (raw.needsInput || !raw.sources?.length) {
    const e = new Error(raw.reason || "资料不足，请补充官网或明确主题");
    e.needsInput = true;
    throw e;
  }
  if (raw.shots.length < 5 || raw.shots.length > 12)
    throw new Error("分镜数量应为5至12，需要重新生成脚本");
  const candidate = projectSchema.parse({
    ...p,
    title: raw.title,
    sources: raw.sources,
    claims: raw.claims,
    shots: raw.shots.map((s) => shotSchema.parse(s)),
  });
  await atomic(path.join(base, "research-evidence.json"), {
    generatedAt: new Date().toISOString(),
    sources: candidate.sources,
    claims: candidate.claims,
  });
  candidate.researchHash = hash(p.topic, p.type, p.focus, p.officialUrls);
  return candidate;
}
export async function image(p, shot, ctx, force = false) {
  const base = dir(p.id);
  const key = hash(shot.prompt, p.referenceImages, "gpt-image-2");
  if (
    !force &&
    shot.image &&
    shot.imageHash === key &&
    (await exists(path.join(base, shot.image)))
  )
    return;
  const journal = path.join(base, "assets/images", `${shot.id}-pending.json`);
  let pending;
  try {
    pending = JSON.parse(await fs.readFile(journal, "utf8"));
  } catch {}
  if (
    !force &&
    pending?.key === key &&
    (await exists(path.join(base, pending.out)))
  ) {
    const recovered = await sharp(path.join(base, pending.out)).metadata();
    if (shot.image) shot.imageVersions.push(shot.image);
    shot.image = pending.out;
    shot.imageHash = key;
    shot.imageSize = { width: recovered.width, height: recovered.height };
    shot.fit = "cover";
    return;
  }
  const out = `assets/images/${shot.id}-${Date.now()}.png`;
  await fs.mkdir(path.join(base, "assets/images"), { recursive: true });
  const prompt =
    shot.prompt +
    "\n统一约束：电影感历史科普场景，9:16竖屏，无文字；器物和建筑依据参考，背景及人物属于艺术想象。重要主体完整可辨，字幕安全区位于画面下部。";
  const promptFile = path.join(
    base,
    "assets/images",
    `${shot.id}-${Date.now()}.prompt.txt`,
  );
  await fs.writeFile(promptFile, prompt);
  const refs = p.referenceImages;
  const args = [
    refs.length ? "edit" : "generate",
    "--model",
    "gpt-image-2",
    "--prompt-file",
    promptFile,
    "--size",
    "1152x2048",
    "--quality",
    "high",
    "--out",
    path.join(base, out),
  ];
  for (const ref of refs) args.push("--image", path.join(base, ref));
  await atomic(journal, { key, out });
  await imageRequest(args, ctx);
  const meta = await sharp(path.join(base, out)).metadata();
  if (shot.image) shot.imageVersions.push(shot.image);
  shot.image = out;
  shot.imageHash = key;
  shot.imageSize = { width: meta.width, height: meta.height };
  shot.fit = "cover";
}
async function imageRequest(args, ctx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run(imagegenCommand, args, {
        signal: ctx.signal,
        timeout: 480000,
      });
    } catch (e) {
      if (
        ctx.signal.aborted ||
        !/(?:429|503|502|504)/i.test(e.message) ||
        attempt === 2
      )
        throw e;
      ctx.log(`图像服务暂时不可用，${(attempt + 1) * 10}秒后重试`);
      await new Promise((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          reject(new Error("任务已取消"));
        };
        const timer = setTimeout(
          () => {
            ctx.signal.removeEventListener("abort", stop);
            resolve();
          },
          (attempt + 1) * 10000,
        );
        ctx.signal.addEventListener("abort", stop, { once: true });
      });
    }
  }
}
export async function audio(p, shot, ctx, force = false) {
  const base = dir(p.id);
  const key = hash(shot.narration, "Tingting", 180);
  if (
    !force &&
    shot.audioHash === key &&
    shot.cues.length &&
    (
      await Promise.all(shot.cues.map((c) => exists(path.join(base, c.audio))))
    ).every(Boolean)
  )
    return;
  const sentences =
    shot.narration
      .match(/[^。！？!?]+[。！？!?]?/g)
      ?.map((s) => s.trim())
      .filter(Boolean) || [];
  if (!sentences.length) throw new Error("旁白不能为空");
  const generated = [];
  await fs.mkdir(path.join(base, "assets/audio"), { recursive: true });
  for (let i = 0; i < sentences.length; i++) {
    ctx.signal.throwIfAborted();
    const stem = `assets/audio/${shot.id}-${Date.now()}-${i}`,
      text = path.join(base, stem + ".txt"),
      raw = path.join(base, stem + ".aiff"),
      mp3 = path.join(base, stem + ".mp3");
    await fs.writeFile(text, sentences[i]);
    await run("say", ["-v", "Tingting", "-r", "180", "-f", text, "-o", raw], {
      signal: ctx.signal,
    });
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        raw,
        "-c:a",
        "libmp3lame",
        "-b:a",
        "160k",
        mp3,
      ],
      { signal: ctx.signal },
    );
    const duration = Number(
      await run(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=nw=1:nk=1",
          mp3,
        ],
        { signal: ctx.signal },
      ),
    );
    generated.push({ text: sentences[i], audio: stem + ".mp3", duration });
    await fs.unlink(raw);
  }
  shot.cues = generated;
}
export async function finishAudio(shot) {
  shot.audioHash = hash(shot.narration, "Tingting", 180);
}
export async function cover(p, ctx, force = false) {
  const base = dir(p.id),
    key = hash(
      p.title,
      p.shots.map((s) => s.image),
    );
  if (
    !force &&
    p.cover &&
    p.coverHash === key &&
    (await exists(path.join(base, p.cover)))
  )
    return;
  await fs.mkdir(path.join(base, "assets/covers"), { recursive: true });
  const journal = path.join(base, "assets/covers/pending.json");
  let pending;
  try {
    pending = JSON.parse(await fs.readFile(journal, "utf8"));
  } catch {}
  if (
    !force &&
    pending?.key === key &&
    (await exists(path.join(base, pending.prefix + ".png")))
  ) {
    await sharp(path.join(base, pending.prefix + ".png"))
      .resize(1080, 1920, { fit: "cover" })
      .jpeg({ quality: 95 })
      .toFile(path.join(base, pending.prefix + ".jpg"));
    p.cover = pending.prefix + ".jpg";
    p.coverHash = key;
    if (!p.coverVersions.includes(p.cover)) p.coverVersions.push(p.cover);
    return;
  }
  const prefix = `assets/covers/cover-${Date.now()}`,
    prompt =
      (await fs.readFile("prompts/cover.txt", "utf8")) +
      "\n片名（逐字准确）：" +
      JSON.stringify(p.title);
  await fs.writeFile(path.join(base, prefix + ".prompt.txt"), prompt);
  const ref = p.shots.find((s) => s.image)?.image;
  const args = [
    ref ? "edit" : "generate",
    "--model",
    "gpt-image-2",
    "--prompt-file",
    path.join(base, prefix + ".prompt.txt"),
    "--size",
    "1152x2048",
    "--quality",
    "high",
    "--out",
    path.join(base, prefix + ".png"),
  ];
  if (ref) args.push("--image", path.join(base, ref));
  await atomic(journal, { key, prefix });
  await imageRequest(args, ctx);
  await sharp(path.join(base, prefix + ".png"))
    .resize(1080, 1920, { fit: "cover" })
    .jpeg({ quality: 95 })
    .toFile(path.join(base, prefix + ".jpg"));
  p.cover = prefix + ".jpg";
  p.coverHash = key;
  p.coverVersions.push(p.cover);
}
export async function render(p, ctx) {
  const issues = qualityIssues(p);
  if (issues.length) {
    const e = new Error(issues.join("；"));
    e.needsInput = true;
    throw e;
  }
  for (const shot of p.shots) {
    for (const file of [shot.image, ...shot.cues.map((c) => c.audio)])
      if (!file || !(await exists(path.join(dir(p.id), file))))
        throw new Error("缺少实际素材：" + file);
  }
  const staging = path.join(dir(p.id), "render-public");
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  await fs.cp(path.join(dir(p.id), "assets"), path.join(staging, "assets"), {
    recursive: true,
  });
  const browserExecutable = process.env.HISTORY_CHROME_PATH || undefined;
  const serveUrl = await bundle({
    entryPoint: path.resolve("video/index.tsx"),
    outDir: path.resolve(".cache", `bundle-${p.id}`),
    publicDir: staging,
    onProgress: (n) => ctx.progress("render", `准备渲染 ${n}%`),
  });
  const inputProps = { project: p };
  const composition = await selectComposition({
    serveUrl,
    id: "HistoryFilm",
    inputProps,
    browserExecutable,
  });
  await fs.mkdir(path.join(dir(p.id), "outputs"), { recursive: true });
  const output = `outputs/film-${Date.now()}.mp4`;
  const { cancelSignal, cancel } = makeCancelSignal();
  const abort = () => cancel();
  ctx.signal.addEventListener("abort", abort, { once: true });
  if (ctx.signal.aborted) cancel();
  try {
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      codec: "h264",
      crf: 20,
      concurrency: 2,
      outputLocation: path.join(dir(p.id), output),
      browserExecutable,
      cancelSignal,
      onProgress: ({ progress }) =>
        ctx.progress("render", `合成 ${Math.round(progress * 100)}%`),
    });
  } finally {
    ctx.signal.removeEventListener("abort", abort);
    await fs.rm(staging, { recursive: true, force: true });
  }
  ctx.signal.throwIfAborted();
  const data = JSON.parse(
    await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        path.join(dir(p.id), output),
      ],
      { signal: ctx.signal },
    ),
  );
  const v = data.streams.find((s) => s.codec_type === "video");
  if (
    v?.width !== 1080 ||
    v?.height !== 1920 ||
    !data.streams.some((s) => s.codec_type === "audio")
  )
    throw new Error("成片媒体检查失败");
  const duration = Number(data.format.duration);
  if (duration < 60 || duration > 90)
    throw new Error("实际成片时长超出60至90秒");
  p.outputs.push({
    id: crypto.randomUUID(),
    path: output,
    createdAt: new Date().toISOString(),
    revision: p.revision,
    duration,
    width: v.width,
    height: v.height,
  });
  await atomic(path.join(dir(p.id), "outputs", `quality-${Date.now()}.json`), {
    duration,
    width: v.width,
    height: v.height,
    audio: true,
    frames: totalFrames(p),
    fps: FPS,
    issues: [],
  });
  return output;
}
export const liveProviders = {
  research,
  image,
  audio,
  finishAudio,
  cover,
  render,
};
