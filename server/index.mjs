import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import crypto from "node:crypto";
import { z } from "zod";
import {
  create,
  read,
  write,
  save,
  list,
  dir,
  PROJECTS,
  ROOT,
  atomic,
} from "./store.mjs";
import { JobManager } from "./jobs.mjs";
import { diagnostics, hash } from "./providers.mjs";
import { redact } from "./process.mjs";
const app = express();
const manager = new JobManager();
await manager.init();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  const host = req.hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host))
    return res.status(403).json({ error: "仅允许本机访问" });
  if (
    req.method !== "GET" &&
    req.headers.origin &&
    !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(
      req.headers.origin,
    )
  )
    return res.status(403).json({ error: "拒绝跨站写入" });
  next();
});
app.get("/api/health", async (req, res) =>
  res.json({ ok: true, dependencies: await diagnostics() }),
);
app.get("/api/projects", async (req, res) => res.json(await list()));
app.post("/api/projects", async (req, res) => {
  const input = z
    .object({
      topic: z.string().trim().min(1).max(160),
      type: z.enum(["building", "museum", "site"]),
      focus: z.string().max(2000).optional(),
      officialUrls: z
        .array(
          z
            .string()
            .url()
            .refine((v) => /^https?:/.test(v)),
        )
        .max(10)
        .optional(),
    })
    .parse(req.body);
  res.status(201).json(await create(input));
});
app.get("/api/projects/:id", async (req, res) =>
  res.json(await read(req.params.id)),
);
app.put("/api/projects/:id", async (req, res) =>
  res.json(await save(req.params.id, req.body)),
);
app.post("/api/projects/:id/jobs", async (req, res) =>
  res
    .status(202)
    .json(
      await manager.enqueue(req.params.id, req.body.scope, req.body.shotId),
    ),
);
app.get("/api/jobs", async (req, res) =>
  res.json(
    manager.jobs
      .filter(
        (j) => !req.query.projectId || j.projectId === req.query.projectId,
      )
      .slice(-100)
      .reverse(),
  ),
);
app.post("/api/jobs/:id/cancel", async (req, res) =>
  res.json(await manager.cancel(req.params.id)),
);
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  const emit = (j) => res.write("data: " + JSON.stringify(j) + "\n\n");
  const timer = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  manager.on("change", emit);
  req.on("close", () => {
    clearInterval(timer);
    manager.off("change", emit);
  });
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});
app.post(
  "/api/projects/:id/upload",
  upload.single("image"),
  async (req, res) => {
    let p = await read(req.params.id);
    if (p.status === "running") throw new Error("请先取消正在进行的制作");
    if (!req.file) throw new Error("请选择图片");
    const sharpImage = sharp(req.file.buffer, { limitInputPixels: 40000000 });
    const meta = await sharpImage.metadata();
    if (!["jpeg", "png", "webp"].includes(meta.format))
      throw new Error("仅支持JPEG、PNG或WebP");
    const file = `assets/uploads/${crypto.randomUUID()}.jpg`;
    await fs.mkdir(path.join(dir(p.id), "assets/uploads"), { recursive: true });
    await sharpImage
      .rotate()
      .resize({
        width: 2160,
        height: 3840,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 95 })
      .toFile(path.join(dir(p.id), file));
    const shot = p.shots.find((s) => s.id === req.body.shotId);
    if (req.body.shotId && !shot) throw new Error("镜头不存在");
    await atomic(
      path.join(dir(p.id), "versions", `upload-${Date.now()}.json`),
      p,
    );
    if (shot) {
      if (shot.image) shot.imageVersions.push(shot.image);
      shot.image = file;
      shot.imageHash = hash(shot.prompt, p.referenceImages, "gpt-image-2");
      const actual = await sharp(path.join(dir(p.id), file)).metadata();
      shot.imageSize = { width: actual.width, height: actual.height };
      shot.fit = actual.width > actual.height ? "contain" : "cover";
    } else {
      p.referenceImages.push(file);
    }
    p.revision++;
    p.status = "draft";
    res.json(await write(p));
  },
);
app.get("/api/projects/:id/download", async (req, res) => {
  const p = await read(req.params.id);
  const requested = req.query.path;
  const allowed = [
    p.cover,
    ...p.coverVersions,
    ...p.outputs.map((o) => o.path),
  ];
  if (!allowed.includes(requested))
    return res.status(404).json({ error: "成品不存在" });
  res.download(path.join(dir(p.id), requested), path.basename(requested));
});
app.use(
  "/media",
  (req, res, next) => {
    if (!/\.(?:png|jpg|jpeg|webp|mp3|mp4)$/i.test(req.path))
      return res.sendStatus(403);
    next();
  },
  express.static(PROJECTS, { dotfiles: "deny" }),
);
const port = Number(process.env.PORT || 4317);
if (process.env.NODE_ENV === "production") {
  app.use(express.static("dist"));
  app.get("/{*path}", (req, res) =>
    res.sendFile(path.resolve("dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: {
      middlewareMode: true,
      hmr: { host: "127.0.0.1", port: 4318 },
      watch: { ignored: ["**/data/**", "**/.cache/**", "**/qa/**"] },
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use((err, req, res, next) => {
  const error =
    err instanceof z.ZodError
      ? err.issues.map((x) => x.message).join("；")
      : redact(err.message);
  res.status(err.code === "ENOENT" ? 404 : 400).json({ error });
});
const server = app.listen(port, "127.0.0.1", () =>
  console.log(`历史文化视频工作台：http://127.0.0.1:${port}`),
);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
