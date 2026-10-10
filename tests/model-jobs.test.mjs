import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  projectSchema,
  timeline,
  totalFrames,
  invalidation,
  safePath,
} from "../shared/model.mjs";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "history-tests-"));
process.env.HISTORY_DATA_DIR = temp;
const store = await import("../server/store.mjs");
const { JobManager, transition } = await import("../server/jobs.mjs");
const { hash } = await import("../server/providers.mjs");
const { redact, run } = await import("../server/process.mjs");
const sample = projectSchema.parse(
  JSON.parse(await fs.readFile("examples/sanxingdui/project.json", "utf8")),
);
const clone = (v) => structuredClone(v);
async function settled(m, j) {
  const end = Date.now() + 5000;
  while (["queued", "running"].includes(j.status)) {
    if (Date.now() > end) throw new Error("测试任务超时");
    await new Promise((r) => setTimeout(r, 15));
  }
  return j;
}
const counters = () => ({
  research: 0,
  image: 0,
  audio: 0,
  cover: 0,
  render: 0,
});
function providers(c, { fail = false, pause = false } = {}) {
  return {
    research: async (p) => {
      c.research++;
      return projectSchema.parse({
        ...p,
        sources: sample.sources,
        claims: sample.claims,
        shots: sample.shots,
        researchHash: hash(p.topic, p.type, p.focus, p.officialUrls),
      });
    },
    image: async (p, s, ctx, force) => {
      if (force || !s.imageHash) {
        c.image++;
        if (fail) throw new Error("模拟图像503");
        if (pause)
          await new Promise((r, reject) =>
            ctx.signal.addEventListener(
              "abort",
              () => reject(new Error("已取消")),
              { once: true },
            ),
          );
        s.image = "assets/fake.png";
        s.imageHash = "done";
      }
    },
    audio: async (p, s, ctx, force) => {
      if (force || !s.audioHash) {
        c.audio++;
        s.cues = [{ text: s.narration, audio: "assets/fake.mp3", duration: 4 }];
      }
    },
    finishAudio: async (s) => {
      s.audioHash = "done";
    },
    cover: async (p) => {
      c.cover++;
      p.cover = "assets/fake.jpg";
    },
    render: async (p) => {
      c.render++;
      p.outputs.push({
        id: "fake-output",
        path: "outputs/fake.mp4",
        createdAt: new Date().toISOString(),
        revision: p.revision,
        duration: 72,
        width: 1080,
        height: 1920,
      });
    },
  };
}
test("schema rejects traversal, missing sources, duplicate shots", () => {
  assert.equal(safePath.safeParse("../secret").success, false);
  assert.equal(safePath.safeParse("assets/test.png").success, true);
  const p = clone(sample);
  p.shots[0].kind = "fact";
  p.shots[0].sourceIds = [];
  assert.equal(projectSchema.safeParse(p).success, false);
  p.shots[0] = clone(sample.shots[0]);
  p.shots.push(p.shots[0]);
  assert.equal(projectSchema.safeParse(p).success, false);
});
test("timeline follows actual audio and contiguous boundaries", () => {
  const rows = timeline(sample);
  for (let i = 1; i < rows.length; i++)
    assert.equal(rows[i].from, rows[i - 1].from + rows[i - 1].frames);
  assert.ok(totalFrames(sample) / 30 >= 60 && totalFrames(sample) / 30 <= 90);
  const p = clone(sample);
  p.shots[0].duration = 2;
  p.shots[0].cues[0].duration = 12;
  assert.ok(timeline(p)[0].seconds > 12);
});
test("invalidation isolates image and audio changes", () => {
  const p = clone(sample);
  p.shots[1].prompt += "x";
  assert.deepEqual(invalidation(sample, p).images, ["shot-2"]);
  assert.deepEqual(invalidation(sample, p).audio, []);
  p.shots[3].narration += "x";
  assert.deepEqual(invalidation(sample, p).audio, ["shot-4"]);
});
test("architecture and museum complete pipeline with simulated providers", async () => {
  for (const type of ["building", "museum"]) {
    const p = await store.create({
      topic: type === "building" ? "佛光寺东大殿" : "陕西历史博物馆",
      type,
    });
    const c = counters(),
      m = new JobManager(providers(c));
    const j = await m.enqueue(p.id);
    await settled(m, j);
    assert.equal(j.status, "completed");
    assert.equal(c.research, 1);
    assert.equal(c.render, 1);
    assert.equal((await store.read(p.id)).status, "ready");
  }
});
test("regeneration only changes requested image and render", async () => {
  const p = { ...clone(sample), id: "partial" };
  await store.write(p);
  const c = counters(),
    m = new JobManager(providers(c));
  const j = await m.enqueue(p.id, "image", "shot-2");
  await settled(m, j);
  assert.equal(c.image, 1);
  assert.equal(c.audio, 0);
  assert.equal(c.research, 0);
  assert.equal(c.render, 1);
  assert.equal(j.status, "completed");
});
test("failed job preserves old material and stops render", async () => {
  const p = { ...clone(sample), id: "failed" };
  await store.write(p);
  const c = counters(),
    m = new JobManager(providers(c, { fail: true }));
  const j = await m.enqueue(p.id, "image", "shot-2");
  await settled(m, j);
  assert.equal(j.status, "failed");
  assert.equal(c.render, 0);
  assert.equal((await store.read(p.id)).shots[1].image, sample.shots[1].image);
});
test("cancel stops downstream tasks and preserves assets", async () => {
  const p = { ...clone(sample), id: "cancel" };
  await store.write(p);
  const c = counters(),
    m = new JobManager(providers(c, { pause: true }));
  const j = await m.enqueue(p.id, "image", "shot-2");
  while (!c.image) await new Promise((r) => setTimeout(r, 10));
  await m.cancel(j.id);
  await settled(m, j);
  assert.equal(j.status, "cancelled");
  assert.equal(c.render, 0);
  assert.equal((await store.read(p.id)).status, "draft");
});
test("restart never reissues running jobs", async () => {
  const p = { ...clone(sample), id: "restart", status: "running" };
  await store.write(p);
  await store.atomic(path.join(temp, "jobs", "restart-job.json"), {
    id: "restart-job",
    projectId: p.id,
    status: "running",
    logs: [],
  });
  const m = new JobManager(providers(counters()));
  await m.init();
  assert.equal(
    m.jobs.find((j) => j.id === "restart-job").status,
    "interrupted",
  );
  assert.equal((await store.read(p.id)).status, "interrupted");
  assert.equal(m.busy, false);
});
test("save rejects stale revision and clears only changed narration hash", async () => {
  const p = { ...clone(sample), id: "edit" };
  await store.write(p);
  const edited = clone(p);
  edited.shots[2].narration += "继续追问。";
  const r = await store.save(p.id, edited);
  assert.equal(r.project.shots[2].audioHash, undefined);
  assert.equal(r.project.shots[1].audioHash, p.shots[1].audioHash);
  await assert.rejects(() => store.save(p.id, edited), /刷新/);
});
test("state transitions and credential redaction", () => {
  assert.throws(() => transition({ status: "completed" }, "running"));
  assert.ok(!redact("sk-123456789ABCDE").includes("123456789ABCDE"));
  assert.ok(!redact("access_token=123456789").includes("123456789"));
});
test("process abort stops child and reports cancellation", async () => {
  const c = new AbortController();
  const promise = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal: c.signal,
  });
  setTimeout(() => c.abort(), 30);
  await assert.rejects(promise, /取消/);
});
test.after(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});
test("completed image journal is recovered without a new API request", async () => {
  const { image } = await import("../server/providers.mjs");
  const { default: sharp } = await import("sharp");
  const p = { ...clone(sample), id: "recover" };
  const s = p.shots[0];
  s.imageHash = undefined;
  await fs.mkdir(path.join(store.dir(p.id), "assets/images"), {
    recursive: true,
  });
  const out = "assets/images/recovered.png";
  await sharp({
    create: { width: 32, height: 64, channels: 3, background: "#112233" },
  })
    .png()
    .toFile(path.join(store.dir(p.id), out));
  await store.atomic(
    path.join(store.dir(p.id), "assets/images", `${s.id}-pending.json`),
    { key: hash(s.prompt, p.referenceImages, "gpt-image-2"), out },
  );
  await image(
    p,
    s,
    { signal: new AbortController().signal, log: () => {} },
    false,
  );
  assert.equal(s.image, out);
  assert.deepEqual(s.imageSize, { width: 32, height: 64 });
});
test("concurrent submissions cannot create two jobs for one project", async () => {
  const p = { ...clone(sample), id: "duplicate" };
  await store.write(p);
  const m = new JobManager(providers(counters()));
  const results = await Promise.allSettled([
    m.enqueue(p.id, "render"),
    m.enqueue(p.id, "render"),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const j = results.find((x) => x.status === "fulfilled").value;
  await settled(m, j);
});
