import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ROOT, read, write, atomic, list, dir } from "./store.mjs";
import { liveProviders, hash } from "./providers.mjs";
import { redact } from "./process.mjs";
export const transitions = {
  queued: ["running", "cancelled", "interrupted"],
  running: ["completed", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};
export function transition(job, status) {
  if (!transitions[job.status]?.includes(status))
    throw new Error("无效任务状态转换");
  job.status = status;
}
export class JobManager extends EventEmitter {
  constructor(providers = liveProviders) {
    super();
    this.providers = providers;
    this.jobs = [];
    this.busy = false;
    this.controllers = new Map();
    this.pendingWrites = new Map();
  }
  async init() {
    await fs.mkdir(path.join(ROOT, "jobs"), { recursive: true });
    for (const name of await fs.readdir(path.join(ROOT, "jobs"))) {
      try {
        const job = JSON.parse(
          await fs.readFile(path.join(ROOT, "jobs", name), "utf8"),
        );
        if (["running", "queued"].includes(job.status)) {
          job.status = "interrupted";
          job.message = "服务重启，中断任务可手动继续；已完成素材保留";
          await this.persist(job);
        }
        this.jobs.push(job);
      } catch {}
    }
    for (const p of await list())
      if (p.status === "running") {
        p.status = "interrupted";
        p.message = "服务重启，点击继续制作";
        await write(p);
      }
  }
  async persist(job) {
    job.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(job);
    const next = (this.pendingWrites.get(job.id) || Promise.resolve())
      .catch(() => {})
      .then(() => atomic(path.join(ROOT, "jobs", job.id + ".json"), snapshot));
    this.pendingWrites.set(job.id, next);
    await next;
    this.emit("change", snapshot);
  }
  async enqueue(projectId, scope = "full", shotId) {
    if (
      !["full", "render", "image", "audio", "cover", "research"].includes(scope)
    )
      throw new Error("无效任务范围");
    if (
      this.jobs.some(
        (j) =>
          j.projectId === projectId && ["queued", "running"].includes(j.status),
      )
    )
      throw new Error("项目已有任务");
    const p = await read(projectId);
    if (
      this.jobs.some(
        (j) =>
          j.projectId === projectId && ["queued", "running"].includes(j.status),
      )
    )
      throw new Error("项目已有任务");
    if (
      ["image", "audio"].includes(scope) &&
      !p.shots.some((s) => s.id === shotId)
    )
      throw new Error("镜头不存在");
    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      projectId,
      scope,
      shotId,
      status: "queued",
      stage: "queued",
      message: "等待制作",
      createdAt: now,
      updatedAt: now,
      logs: [],
    };
    this.jobs.push(job);
    p.status = "running";
    await write(p);
    await this.persist(job);
    queueMicrotask(() => this.pump());
    return job;
  }
  async cancel(id) {
    const j = this.jobs.find((j) => j.id === id);
    if (!j) throw new Error("任务不存在");
    if (j.status === "queued") {
      transition(j, "cancelled");
      j.message = "已取消";
      const p = await read(j.projectId);
      p.status = "draft";
      p.message = "任务已取消";
      await write(p);
      await this.persist(j);
    } else if (j.status === "running") {
      this.controllers.get(id)?.abort();
      j.message = "正在取消，保留已完成素材";
      await this.persist(j);
    }
    return j;
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      let job;
      while ((job = this.jobs.find((j) => j.status === "queued"))) {
        await this.execute(job);
      }
    } finally {
      this.busy = false;
    }
  }
  async execute(job) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    transition(job, "running");
    await this.persist(job);
    let p = await read(job.projectId);
    let last = 0;
    const ctx = {
      signal: controller.signal,
      log: (m) => {
        job.logs.push(redact(m).slice(0, 3000));
        job.logs = job.logs.slice(-60);
      },
      progress: (stage, message) => {
        job.stage = stage;
        job.message = message;
        if (Date.now() - last > 900) {
          last = Date.now();
          this.persist(job).catch(() => {});
        }
      },
    };
    const checkpoint = async (stage, message) => {
      controller.signal.throwIfAborted();
      job.stage = stage;
      job.message = message;
      await write(p);
      await this.persist(job);
    };
    try {
      await atomic(
        path.join(dir(p.id), "versions", `before-job-${job.id}.json`),
        p,
      );
      if (job.scope !== "render") p.revision++;
      if (
        ["full", "research"].includes(job.scope) &&
        (!p.shots.length ||
          p.researchHash !== hash(p.topic, p.type, p.focus, p.officialUrls) ||
          job.scope === "research")
      ) {
        await checkpoint("research", "检索资料并编写故事");
        p = await this.providers.research(p, ctx);
        await checkpoint("research", "资料与分镜已保存");
      }
      if (["full", "render", "image", "audio"].includes(job.scope)) {
        const selected = ["full", "render"].includes(job.scope)
          ? p.shots
          : p.shots.filter((s) => s.id === job.shotId);
        for (let i = 0; i < selected.length; i++) {
          const shot = selected[i];
          if (["full", "render", "image"].includes(job.scope)) {
            await checkpoint(
              "image",
              `画面 ${i + 1}/${selected.length} · ${shot.title}`,
            );
            await this.providers.image(p, shot, ctx, job.scope === "image");
            await checkpoint("image", `${shot.title}画面已保存`);
          }
          if (["full", "render", "audio"].includes(job.scope)) {
            await checkpoint("audio", `旁白 · ${shot.title}`);
            await this.providers.audio(p, shot, ctx, job.scope === "audio");
            await this.providers.finishAudio(shot);
            await checkpoint("audio", `${shot.title}旁白已保存`);
          }
        }
      }
      if (["full", "cover"].includes(job.scope)) {
        await checkpoint("cover", "制作竖屏视频封面");
        await this.providers.cover(p, ctx, job.scope === "cover");
        await checkpoint("cover", "封面已保存");
      }
      if (["full", "render", "image", "audio"].includes(job.scope)) {
        await checkpoint("render", "检查素材并开始合成");
        await this.providers.render(p, ctx);
      }
      controller.signal.throwIfAborted();
      p.status = job.scope === "research" ? "draft" : "ready";
      p.message = "";
      await write(p);
      transition(job, "completed");
      job.message = "制作完成";
      job.stage = "completed";
      await this.persist(job);
    } catch (e) {
      const cancelled = controller.signal.aborted;
      p.status = cancelled ? "draft" : e.needsInput ? "needs_input" : "failed";
      p.message = cancelled
        ? "已取消，完成的素材已保留"
        : redact(e.message).slice(-3000);
      await write(p);
      transition(job, cancelled ? "cancelled" : "failed");
      job.message = p.message;
      await this.persist(job);
    } finally {
      this.controllers.delete(job.id);
    }
  }
}
