import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { projectSchema, invalidation } from "../shared/model.mjs";
export const ROOT = path.resolve(process.env.HISTORY_DATA_DIR || "data");
export const PROJECTS = path.join(ROOT, "projects");
export const validId = (v) =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
export function dir(id) {
  if (!validId(id)) throw new Error("无效项目ID");
  return path.join(PROJECTS, id);
}
export async function atomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + crypto.randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, file);
}
export async function read(id) {
  return projectSchema.parse(
    JSON.parse(await fs.readFile(path.join(dir(id), "project.json"), "utf8")),
  );
}
export async function write(p) {
  p.updatedAt = new Date().toISOString();
  await atomic(path.join(dir(p.id), "project.json"), projectSchema.parse(p));
  return p;
}
export async function list() {
  await fs.mkdir(PROJECTS, { recursive: true });
  const out = [];
  for (const id of await fs.readdir(PROJECTS)) {
    try {
      out.push(await read(id));
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function create(input) {
  const now = new Date().toISOString();
  return write(
    projectSchema.parse({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      topic: input.topic,
      title: input.topic,
      type: input.type,
      focus: input.focus || "",
      officialUrls: input.officialUrls || [],
      createdAt: now,
      updatedAt: now,
      revision: 0,
    }),
  );
}
export async function save(id, input) {
  const before = await read(id);
  if (before.status === "running")
    throw new Error("制作期间不能修改，请先取消");
  if (input.revision !== before.revision)
    throw new Error("项目已更新，请刷新后再保存");
  const after = projectSchema.parse({
    ...input,
    id,
    createdAt: before.createdAt,
    outputs: before.outputs,
    coverVersions: before.coverVersions,
    revision: before.revision + 1,
    status: "draft",
    message: "",
  });
  const change = invalidation(before, after);
  for (const s of after.shots) {
    if (change.images.includes(s.id)) s.imageHash = undefined;
    if (change.audio.includes(s.id)) s.audioHash = undefined;
  }
  if (change.cover) after.coverHash = undefined;
  await atomic(
    path.join(
      dir(id),
      "versions",
      `project-${before.revision}-${Date.now()}.json`,
    ),
    before,
  );
  return { project: await write(after), change };
}
