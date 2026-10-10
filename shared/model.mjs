import { z } from "zod";
export const safePath = z
  .string()
  .max(300)
  .refine(
    (v) =>
      !v.startsWith("/") &&
      !v.includes("..") &&
      !v.includes("\\") &&
      !v.includes(":"),
    "素材路径必须为项目内相对路径",
  );
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const sourceSchema = z.object({
  id,
  title: z.string().min(1).max(300),
  url: z
    .string()
    .url()
    .refine((v) => /^https?:/.test(v)),
  summary: z.string().max(4000),
});
export const kind = z.enum(["fact", "legend", "imagination"]);
export const cueSchema = z.object({
  text: z.string().min(1).max(400),
  audio: safePath,
  duration: z.number().positive().max(120),
});
export const shotSchema = z.object({
  id,
  title: z.string().min(1).max(200),
  narration: z.string().min(1).max(1200),
  prompt: z.string().min(1).max(8000),
  kind,
  sourceIds: z.array(id),
  duration: z.number().min(2).max(40),
  image: safePath.optional(),
  imageHash: z.string().optional(),
  imageVersions: z.array(safePath).default([]),
  audioHash: z.string().optional(),
  cues: z.array(cueSchema).default([]),
  fit: z.enum(["cover", "contain"]).default("cover"),
  focusX: z.number().min(0).max(100).default(50),
  focusY: z.number().min(0).max(100).default(50),
  zoom: z.number().min(1).max(1.2).default(1.05),
  imageSize: z.object({ width: z.number(), height: z.number() }).optional(),
});
export const projectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    title: z.string().min(1).max(160),
    topic: z.string().min(1).max(160),
    type: z.enum(["building", "museum", "site"]),
    focus: z.string().max(2000).default(""),
    officialUrls: z.array(z.string().url()).default([]),
    referenceImages: z.array(safePath).default([]),
    researchHash: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    revision: z.number().int().nonnegative(),
    sources: z.array(sourceSchema).default([]),
    claims: z
      .array(
        z.object({
          id,
          text: z.string().min(1).max(2000),
          kind,
          sourceIds: z.array(id),
        }),
      )
      .default([]),
    shots: z.array(shotSchema).max(20).default([]),
    cover: safePath.optional(),
    coverHash: z.string().optional(),
    ambience: safePath.optional(),
    outputs: z
      .array(
        z.object({
          id,
          path: safePath,
          createdAt: z.string(),
          revision: z.number(),
          duration: z.number(),
          width: z.number(),
          height: z.number(),
        }),
      )
      .default([]),
    coverVersions: z.array(safePath).default([]),
    status: z
      .enum([
        "draft",
        "running",
        "needs_input",
        "failed",
        "ready",
        "interrupted",
      ])
      .default("draft"),
    message: z.string().default(""),
    originalFormat: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    const ids = new Set(p.sources.map((s) => s.id));
    if (ids.size !== p.sources.length)
      ctx.addIssue({ code: "custom", message: "资料ID重复" });
    if (new Set(p.shots.map((s) => s.id)).size !== p.shots.length)
      ctx.addIssue({ code: "custom", message: "镜头ID重复" });
    for (const x of [...p.claims, ...p.shots]) {
      if (x.sourceIds.some((s) => !ids.has(s)))
        ctx.addIssue({ code: "custom", message: "引用资料不存在" });
      if (x.kind !== "imagination" && !x.sourceIds.length)
        ctx.addIssue({ code: "custom", message: "事实或传说需要资料依据" });
    }
  });
export const FPS = 30;
/** @param {import('zod').infer<typeof projectSchema>} p */
export function timeline(p) {
  let cursor = 0;
  return p.shots.map((shot) => {
    const audioDuration =
      shot.cues.reduce((n, c) => n + c.duration + 0.22, 0) + 0.45;
    const seconds = Math.max(shot.duration, audioDuration);
    const frames = Math.ceil(seconds * FPS);
    const row = { shot, from: cursor, frames, seconds: frames / FPS };
    cursor += frames;
    return row;
  });
}
export function totalFrames(p) {
  return Math.max(
    1,
    timeline(p).reduce((n, s) => n + s.frames, 0),
  );
}
export function invalidation(before, after) {
  const changed = { images: [], audio: [], render: false, cover: false };
  for (const s of after.shots) {
    const prev = before.shots.find((x) => x.id === s.id);
    if (!prev || prev.prompt !== s.prompt) changed.images.push(s.id);
    if (!prev || prev.narration !== s.narration) changed.audio.push(s.id);
  }
  changed.render =
    JSON.stringify(before.shots) !== JSON.stringify(after.shots) ||
    before.title !== after.title;
  changed.cover = before.title !== after.title;
  return changed;
}
export function qualityIssues(p) {
  const issues = [];
  if (!p.sources.length) issues.push("没有可追溯资料");
  if (!p.shots.length) issues.push("没有分镜");
  for (const s of p.shots) {
    if (!s.image) issues.push(`${s.title}缺少图片`);
    if (!s.cues.length) issues.push(`${s.title}缺少旁白`);
  }
  const seconds = totalFrames(p) / FPS;
  if (seconds < 60 || seconds > 90)
    issues.push(`时长${seconds.toFixed(1)}秒，目标为60至90秒`);
  return issues;
}
