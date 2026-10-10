import React, { useState, useEffect, useRef } from "react";
import { Player } from "@remotion/player";
import { Film, type FilmProject } from "../video/Film";
import { totalFrames, FPS, qualityIssues } from "../shared/model.mjs";
import {
  Plus,
  ArrowLeft,
  Play,
  Film as FilmIcon,
  Landmark,
  Library,
  Compass,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  Upload,
  Download,
  Save,
  Square,
  Check,
  BookOpen,
  Image as ImageIcon,
  Layers,
  ChevronRight,
} from "lucide-react";
type Job = {
  id: string;
  projectId: string;
  status: string;
  stage: string;
  message: string;
  scope: string;
  logs: string[];
};
type Dependency = { label: string; available: boolean };
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const r = await fetch("/api" + url, {
    ...options,
    headers:
      options?.body instanceof FormData
        ? undefined
        : { "Content-Type": "application/json", ...options?.headers },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || "请求失败");
  return body;
}
const kinds = { fact: "历史依据", legend: "文献传说", imagination: "艺术想象" };
const types = { building: "历史建筑", museum: "博物馆", site: "遗址" };
const statuses: Record<string, string> = {
  draft: "待制作",
  running: "制作中",
  ready: "已完成",
  failed: "制作失败",
  needs_input: "需补充资料",
  interrupted: "可继续制作",
};
export default function App() {
  const [projects, setProjects] = useState<FilmProject[]>([]),
    [p, setP] = useState<FilmProject | null>(null),
    [tab, setTab] = useState("content"),
    [jobs, setJobs] = useState<Job[]>([]),
    [deps, setDeps] = useState<Dependency[]>([]),
    [modal, setModal] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [selected, setSelected] = useState(""),
    [downloadVersion, setDownloadVersion] = useState("");
  const pRef = useRef(p),
    dirtyRef = useRef(dirty);
  pRef.current = p;
  dirtyRef.current = dirty;
  const refreshList = () => api<FilmProject[]>("/projects").then(setProjects);
  useEffect(() => {
    refreshList();
    api<{ dependencies: Dependency[] }>("/health")
      .then((r) => setDeps(r.dependencies))
      .catch((e) => setError(e.message));
    const events = new EventSource("/api/events");
    events.onmessage = (e) => {
      const job: Job = JSON.parse(e.data);
      if (job.projectId === pRef.current?.id) {
        api<Job[]>("/jobs?projectId=" + job.projectId).then(setJobs);
        if (
          ["completed", "failed", "cancelled", "interrupted"].includes(
            job.status,
          ) &&
          !dirtyRef.current
        )
          api<FilmProject>("/projects/" + job.projectId).then(setP);
      }
      refreshList();
    };
    return () => events.close();
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const open = async (project: FilmProject) => {
    setP(await api<FilmProject>("/projects/" + project.id));
    setJobs(await api<Job[]>("/jobs?projectId=" + project.id));
    setTab("content");
    setDirty(false);
    setSelected(project.shots[0]?.id || "");
    setDownloadVersion("");
  };
  const update = (patch: Partial<FilmProject>) => {
    if (p) {
      setP({ ...p, ...patch });
      setDirty(true);
    }
  };
  const editShot = (
    id: string,
    patch: Partial<FilmProject["shots"][number]>,
  ) => {
    if (p)
      update({
        shots: p.shots.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      });
  };
  const persist = async () => {
    if (!p) throw new Error("未选择项目");
    if (!dirty) return p;
    const r = await api<{ project: FilmProject }>("/projects/" + p.id, {
      method: "PUT",
      body: JSON.stringify(p),
    });
    setP(r.project);
    setDirty(false);
    setNotice("修改已保存，已有成片作为旧版本保留");
    return r.project;
  };
  const start = async (scope: string, shotId?: string) => {
    const project = await persist();
    const job = await api<Job>("/projects/" + project.id + "/jobs", {
      method: "POST",
      body: JSON.stringify({ scope, shotId }),
    });
    setJobs([job, ...jobs]);
    setP({ ...project, status: "running" });
    setNotice("任务已启动，可查看制作进度");
  };
  const upload = async (file: File, shotId?: string) => {
    const project = await persist();
    const form = new FormData();
    form.append("image", file);
    if (shotId) form.append("shotId", shotId);
    setP(
      await api<FilmProject>("/projects/" + project.id + "/upload", {
        method: "POST",
        body: form,
      }),
    );
    setNotice("图片已保存");
  };
  const job = jobs.find((j) => ["queued", "running"].includes(j.status));
  const locked = !!job || p?.status === "running";
  const shot = p?.shots.find((s) => s.id === selected) || p?.shots[0];
  const latest = p?.outputs.at(-1);
  const output = p?.outputs.find((o) => o.path === downloadVersion) || latest;
  const stale = !!latest && !!p && (latest.revision !== p.revision || dirty);
  const missing = deps.filter((d) => !d.available);
  const media = (file?: string) => (file && p ? `/media/${p.id}/${file}` : "");
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setP(null);
            refreshList();
          }}
        >
          <Landmark size={27} />
          <span>
            古迹<small>历史文化视频工作台</small>
          </span>
        </a>
        <div className="side-heading">创作空间</div>
        <button
          className={!p ? "side-link active" : "side-link"}
          onClick={() => {
            setP(null);
            refreshList();
          }}
        >
          <Layers size={18} />
          全部项目<span>{projects.length}</span>
        </button>
        <button className="side-link" onClick={() => setModal(true)}>
          <Plus size={18} />
          新建历史故事
        </button>
        <div className="side-heading">最近项目</div>
        {projects.slice(0, 5).map((project) => (
          <button
            key={project.id}
            className={
              p?.id === project.id ? "project-link active" : "project-link"
            }
            onClick={() => act(() => open(project))}
          >
            <span className="project-dot" />
            {project.topic}
          </button>
        ))}
        <div className="sidebar-bottom">
          <span className="local-dot" />
          本机工作空间<p>Codex × GPT-Image-2 × Remotion</p>
          <small>资料有据，想象有界。</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>{p ? "创作空间 / " + p.topic : "创作空间 / 全部项目"}</span>
          <span className="local-tag">LOCAL STUDIO</span>
        </header>
        {error && (
          <div role="alert" className="alert error">
            {error}
            <button onClick={() => setError("")}>关闭</button>
          </div>
        )}
        {notice && (
          <div role="status" className="alert">
            {notice}
          </div>
        )}
        {missing.length > 0 && (
          <div className="alert error">
            制作依赖缺失：{missing.map((d) => d.label).join("、")}
            。安装后刷新页面。
          </div>
        )}
        {!p ? (
          <section className="home">
            <div className="intro">
              <div>
                <p className="eyebrow">让遗存成为故事</p>
                <h1>
                  从一处古迹，
                  <br />
                  走进一个时代。
                </h1>
                <p className="lead">
                  沿着建筑、器物与文献，制作有依据的历史文化短片。
                  <br />
                  从一个主题开始，让故事有画面、有声音。
                </p>
                <button className="primary" onClick={() => setModal(true)}>
                  <Plus size={18} />
                  开始新故事
                </button>
              </div>
              <div className="hero-poster">
                {projects.find((x) => x.cover) && (
                  <img
                    src={`/media/${projects.find((x) => x.cover)!.id}/${projects.find((x) => x.cover)!.cover}`}
                    alt="三星堆短片封面"
                  />
                )}
                <div className="poster-caption">
                  一张面具，一个古蜀世界。<span>首个创作样例 / 三星堆</span>
                </div>
              </div>
            </div>
            <div className="section-heading">
              <h2>你的故事</h2>
              <span>{projects.length} 个项目 · 竖屏优先</span>
            </div>
            <div className="project-grid">
              {projects.map((project) => (
                <button
                  key={project.id}
                  className="project-card"
                  onClick={() => act(() => open(project))}
                >
                  <div className="card-image">
                    {project.cover ? (
                      <img
                        src={`/media/${project.id}/${project.cover}`}
                        alt={project.title}
                      />
                    ) : (
                      <Landmark size={48} />
                    )}
                    <span>{types[project.type]}</span>
                  </div>
                  <div className="card-copy">
                    <span className={"status " + project.status}>
                      {statuses[project.status]}
                    </span>
                    <h3>{project.title}</h3>
                    <p>
                      {project.shots.length} 个镜头 ·{" "}
                      {project.shots.length
                        ? (totalFrames(project) / FPS).toFixed(0) + "秒"
                        : "等待编写"}
                      <ChevronRight size={18} />
                    </p>
                  </div>
                </button>
              ))}
              <button className="new-card" onClick={() => setModal(true)}>
                <Plus size={26} />
                <h3>下一个历史故事</h3>
                <p>建筑 · 博物馆 · 遗址</p>
              </button>
            </div>
            <div className="process-strip">
              {["寻找依据", "组织故事", "生成画面与声音", "合成短片与封面"].map(
                (s, i) => (
                  <span key={s}>
                    <b>0{i + 1}</b>
                    {s}
                  </span>
                ),
              )}
            </div>
          </section>
        ) : (
          <section className="workspace">
            <div className="workspace-title">
              <div>
                <button
                  className="back-link"
                  onClick={() => {
                    if (dirty && !confirm("有未保存修改，仍返回吗？")) return;
                    setP(null);
                    refreshList();
                  }}
                >
                  <ArrowLeft size={15} />
                  全部项目
                </button>
                <h1>{p.title}</h1>
                <p>
                  {types[p.type]} · 9:16 · {(totalFrames(p) / FPS).toFixed(1)}秒{" "}
                  <span className={"status " + p.status}>
                    {statuses[p.status]}
                  </span>
                  {p.originalFormat && <span>原样例：{p.originalFormat}</span>}
                </p>
              </div>
              <div className="actions">
                <button
                  disabled={busy || locked || !dirty}
                  onClick={() =>
                    act(async () => {
                      await persist();
                    })
                  }
                >
                  <Save size={16} />
                  保存修改{dirty ? " *" : ""}
                </button>
                <button
                  className="primary"
                  disabled={busy || locked || missing.length > 0}
                  onClick={() => act(() => start("full"))}
                >
                  <Play size={16} />
                  一键制作
                </button>
              </div>
            </div>
            {p.message && !locked && (
              <div
                className={"alert " + (p.status === "failed" ? "error" : "")}
              >
                {p.message}
              </div>
            )}
            {job && (
              <div className="job-panel">
                <div>
                  <span className="spinner" />
                  <strong>{job.message}</strong>
                  <span>{job.status === "queued" ? "排队中" : "运行中"}</span>
                  <button
                    onClick={() =>
                      act(async () => {
                        await api("/jobs/" + job.id + "/cancel", {
                          method: "POST",
                        });
                      })
                    }
                  >
                    <Square size={12} />
                    取消任务
                  </button>
                </div>
                <div className="stages">
                  {[
                    "research",
                    "image",
                    "audio",
                    "cover",
                    "render",
                    "completed",
                  ].map((stage, i) => (
                    <span
                      key={stage}
                      className={job.stage === stage ? "current" : ""}
                    >
                      {
                        ["资料与叙事", "画面", "旁白", "封面", "合成", "完成"][
                          i
                        ]
                      }
                    </span>
                  ))}
                </div>
              </div>
            )}
            <nav className="tabs">
              {[
                ["content", "内容与依据", BookOpen],
                ["shots", "分镜与素材", ImageIcon],
                ["output", "成片与封面", FilmIcon],
              ].map(([key, label, Icon]) => {
                const C = Icon as typeof BookOpen;
                return (
                  <button
                    key={key as string}
                    className={tab === key ? "active" : ""}
                    onClick={() => setTab(key as string)}
                  >
                    <C size={17} />
                    {label as string}
                  </button>
                );
              })}
            </nav>
            {tab === "content" && (
              <div className="content-grid">
                <div>
                  <section className="panel">
                    <h2>故事的起点</h2>
                    <label>
                      影片标题
                      <input
                        disabled={locked}
                        value={p.title}
                        onChange={(e) => update({ title: e.target.value })}
                      />
                    </label>
                    <div className="form-row">
                      <label>
                        主题名称
                        <input
                          disabled={locked}
                          value={p.topic}
                          onChange={(e) => update({ topic: e.target.value })}
                        />
                      </label>
                      <label>
                        题材
                        <select
                          disabled={locked}
                          value={p.type}
                          onChange={(e) =>
                            update({
                              type: e.target.value as FilmProject["type"],
                            })
                          }
                        >
                          {Object.entries(types).map(([v, t]) => (
                            <option key={v} value={v}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label>
                      讲述重点
                      <textarea
                        disabled={locked}
                        value={p.focus}
                        placeholder="希望观众记住哪个问题或故事？"
                        onChange={(e) => update({ focus: e.target.value })}
                      />
                    </label>
                    <label>
                      官网或研究链接（每行一个）
                      <textarea
                        disabled={locked}
                        value={p.officialUrls.join("\n")}
                        onChange={(e) =>
                          update({
                            officialUrls: e.target.value
                              .split("\n")
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <label className="upload-label">
                      <Upload size={16} />
                      添加参考照片
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={busy || locked}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) act(() => upload(f));
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <div className="references">
                      {p.referenceImages.map((f) => (
                        <img key={f} src={media(f)} alt="主题参考照片" />
                      ))}
                    </div>
                    <button
                      disabled={busy || locked || missing.length > 0}
                      onClick={() => act(() => start("research"))}
                    >
                      <RotateCcw size={15} />
                      重新检索与编写分镜
                    </button>
                    <p className="hint">
                      重新检索会替换当前脚本，旧版本保留在项目目录。
                    </p>
                  </section>
                  <section className="panel">
                    <h2>史实、传说与想象</h2>
                    {!p.claims.length ? (
                      <p className="empty">
                        制作后将在这里呈现可追溯的故事依据。
                      </p>
                    ) : (
                      p.claims.map((c) => (
                        <div className="claim" key={c.id}>
                          <span className={"kind " + c.kind}>
                            {kinds[c.kind]}
                          </span>
                          <p>{c.text}</p>
                          <small>
                            {c.sourceIds
                              .map(
                                (id) =>
                                  p.sources.find((s) => s.id === id)?.title,
                              )
                              .join(" · ") || "明确标注的艺术想象"}
                          </small>
                        </div>
                      ))
                    )}
                  </section>
                </div>
                <aside>
                  <section className="panel">
                    <h2>
                      资料来源 <span className="count">{p.sources.length}</span>
                    </h2>
                    {p.sources.map((s) => (
                      <article className="source" key={s.id}>
                        <a href={s.url} target="_blank" rel="noreferrer">
                          {s.title} ↗
                        </a>
                        <p>{s.summary}</p>
                        <small>{new URL(s.url).hostname}</small>
                      </article>
                    ))}
                    {!p.sources.length && (
                      <p className="empty">
                        优先读取官网、研究机构与原始文献。
                      </p>
                    )}
                  </section>
                  <section className="editorial-note">
                    <Compass size={22} />
                    <h3>先有依据，再有想象。</h3>
                    <p>
                      传说不等于已证实历史。人物、陈设与祭礼动作的重建，需要保留艺术想象标注。
                    </p>
                  </section>
                </aside>
              </div>
            )}
            {tab === "shots" && (
              <div className="shot-layout">
                <aside className="shot-list">
                  {p.shots.map((s, i) => (
                    <button
                      key={s.id}
                      className={
                        shot?.id === s.id ? "shot-item selected" : "shot-item"
                      }
                      onClick={() => setSelected(s.id)}
                    >
                      {s.image ? (
                        <img src={media(s.image)} alt="" />
                      ) : (
                        <div className="shot-placeholder">{i + 1}</div>
                      )}
                      <div>
                        <small>
                          镜头 {String(i + 1).padStart(2, "0")} ·{" "}
                          {s.duration.toFixed(1)}秒
                        </small>
                        <strong>{s.title}</strong>
                        <span>{kinds[s.kind]}</span>
                      </div>
                    </button>
                  ))}
                  {!p.shots.length && (
                    <p className="empty">点击一键制作生成分镜。</p>
                  )}
                </aside>
                {shot && (
                  <section className="panel shot-editor">
                    <div className="shot-heading">
                      <h2>{shot.title}</h2>
                      <div className="actions">
                        {[-1, 1].map((d, i) => (
                          <button
                            key={d}
                            aria-label={i ? "镜头下移" : "镜头上移"}
                            disabled={
                              locked ||
                              p.shots.indexOf(shot) + d < 0 ||
                              p.shots.indexOf(shot) + d >= p.shots.length
                            }
                            onClick={() => {
                              const arr = [...p.shots],
                                a = arr.indexOf(shot),
                                b = a + d;
                              [arr[a], arr[b]] = [arr[b], arr[a]];
                              update({ shots: arr });
                            }}
                          >
                            {i ? (
                              <ArrowDown size={16} />
                            ) : (
                              <ArrowUp size={16} />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="shot-edit-grid">
                      <div>
                        <div className="shot-preview">
                          {shot.image ? (
                            <img
                              src={media(shot.image)}
                              alt={shot.title}
                              style={{
                                objectFit: shot.fit,
                                objectPosition: `${shot.focusX}% ${shot.focusY}%`,
                              }}
                            />
                          ) : (
                            <p>尚未生成画面</p>
                          )}
                        </div>
                        <div className="actions">
                          <button
                            disabled={busy || locked}
                            onClick={() => act(() => start("image", shot.id))}
                          >
                            <RotateCcw size={14} />
                            重做画面
                          </button>
                          <label className="upload-label">
                            <Upload size={14} />
                            替换
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              disabled={busy || locked}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) act(() => upload(f, shot.id));
                                e.target.value = "";
                              }}
                            />
                          </label>
                        </div>
                        <small className="hint">
                          {shot.imageSize
                            ? `${shot.imageSize.width}×${shot.imageSize.height} · 实际素材尺寸`
                            : "生成后记录实际尺寸"}
                        </small>
                        {shot.imageVersions.length > 0 && (
                          <details>
                            <summary>
                              历史画面（{shot.imageVersions.length}）
                            </summary>
                            <div className="references">
                              {shot.imageVersions.map((f) => (
                                <a
                                  key={f}
                                  href={media(f)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <img src={media(f)} alt="历史画面" />
                                </a>
                              ))}
                            </div>
                          </details>
                        )}
                        <label>
                          画面适配
                          <select
                            disabled={locked}
                            value={shot.fit}
                            onChange={(e) =>
                              editShot(shot.id, {
                                fit: e.target.value as "cover" | "contain",
                              })
                            }
                          >
                            <option value="cover">铺满竖屏</option>
                            <option value="contain">完整保留主体</option>
                          </select>
                        </label>
                        <label>
                          水平焦点
                          <input
                            disabled={locked}
                            type="range"
                            min="0"
                            max="100"
                            value={shot.focusX}
                            onChange={(e) =>
                              editShot(shot.id, {
                                focusX: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                      </div>
                      <div>
                        <label>
                          镜头标题
                          <input
                            disabled={locked}
                            value={shot.title}
                            onChange={(e) =>
                              editShot(shot.id, { title: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          旁白
                          <textarea
                            disabled={locked}
                            value={shot.narration}
                            onChange={(e) =>
                              editShot(shot.id, { narration: e.target.value })
                            }
                          />
                        </label>
                        <div className="audio-list">
                          {shot.cues.map((c, i) => (
                            <div key={c.audio}>
                              <small>
                                第{i + 1}句 · {c.duration.toFixed(2)}秒
                              </small>
                              <audio controls src={media(c.audio)} />
                            </div>
                          ))}
                        </div>
                        <button
                          disabled={busy || locked}
                          onClick={() => act(() => start("audio", shot.id))}
                        >
                          <RotateCcw size={14} />
                          重做旁白并合成
                        </button>
                        <label>
                          生成提示词
                          <textarea
                            className="prompt"
                            disabled={locked}
                            value={shot.prompt}
                            onChange={(e) =>
                              editShot(shot.id, { prompt: e.target.value })
                            }
                          />
                        </label>
                        <div className="form-row">
                          <label>
                            镜头最短时长（秒）
                            <input
                              type="number"
                              min="2"
                              max="40"
                              step=".1"
                              disabled={locked}
                              value={shot.duration}
                              onChange={(e) =>
                                editShot(shot.id, {
                                  duration: Number(e.target.value),
                                })
                              }
                            />
                          </label>
                          <label>
                            依据类型
                            <select
                              disabled={locked}
                              value={shot.kind}
                              onChange={(e) =>
                                editShot(shot.id, {
                                  kind: e.target
                                    .value as FilmProject["shots"][number]["kind"],
                                })
                              }
                            >
                              {Object.entries(kinds).map(([v, t]) => (
                                <option key={v} value={v}>
                                  {t}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <label>
                          引用资料
                          <select
                            multiple
                            disabled={locked}
                            value={shot.sourceIds}
                            onChange={(e) =>
                              editShot(shot.id, {
                                sourceIds: [...e.target.selectedOptions].map(
                                  (o) => o.value,
                                ),
                              })
                            }
                          >
                            {p.sources.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <p className="hint">
                          时长自动容纳真实旁白；字幕按每句音频同步，不压缩语速。
                        </p>
                      </div>
                    </div>
                  </section>
                )}
              </div>
            )}
            {tab === "output" && (
              <div className="output-grid">
                <section className="panel">
                  <div className="section-heading">
                    <h2>视频预览</h2>
                    <span>1080×1920 / 30fps</span>
                  </div>
                  {p.shots.length > 0 ? (
                    <div className="player-wrap">
                      <Player
                        component={Film}
                        inputProps={{
                          project: p,
                          mediaBase: `/media/${p.id}/`,
                        }}
                        durationInFrames={totalFrames(p)}
                        compositionWidth={1080}
                        compositionHeight={1920}
                        fps={FPS}
                        controls
                        style={{ width: "100%", height: "100%" }}
                      />
                    </div>
                  ) : (
                    <p className="empty">完成分镜后可预览。</p>
                  )}
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={busy || locked || !p.shots.length}
                      onClick={() => act(() => start("render"))}
                    >
                      <FilmIcon size={16} />
                      重新合成
                    </button>
                    {output && (
                      <a
                        className="button"
                        href={`/api/projects/${p.id}/download?path=${encodeURIComponent(output.path)}`}
                      >
                        <Download size={16} />
                        下载MP4
                      </a>
                    )}
                  </div>
                  {stale && (
                    <p className="hint warning">
                      已有成片对应旧版本；请合成后下载当前修改。
                    </p>
                  )}
                  {qualityIssues(p).length > 0 && (
                    <p className="hint warning">
                      {qualityIssues(p).join("；")}
                    </p>
                  )}
                  <h3>导出版本</h3>
                  <select
                    value={downloadVersion || latest?.path || ""}
                    onChange={(e) => setDownloadVersion(e.target.value)}
                  >
                    <option value="" disabled>
                      选择导出版本
                    </option>
                    {[...p.outputs].reverse().map((o, i) => (
                      <option key={o.id} value={o.path}>
                        {i === 0 ? "最新 · " : ""}版本 {o.revision} ·{" "}
                        {o.duration.toFixed(1)}秒 ·{" "}
                        {new Date(o.createdAt).toLocaleString("zh-CN")}
                      </option>
                    ))}
                  </select>
                  {output && (
                    <video
                      className="exported-video"
                      controls
                      preload="metadata"
                      src={media(output.path)}
                    />
                  )}
                </section>
                <section className="panel cover-panel">
                  <div className="section-heading">
                    <h2>视频封面</h2>
                    <span>9:16</span>
                  </div>
                  {p.cover ? (
                    <img
                      className="cover"
                      src={media(p.cover)}
                      alt={p.title + "竖屏封面"}
                    />
                  ) : (
                    <p className="empty">制作完成后生成封面。</p>
                  )}
                  <div className="actions">
                    <button
                      disabled={busy || locked || !p.shots.length}
                      onClick={() => act(() => start("cover"))}
                    >
                      <RotateCcw size={15} />
                      重做封面
                    </button>
                    {p.cover && (
                      <a
                        className="button"
                        href={`/api/projects/${p.id}/download?path=${encodeURIComponent(p.cover)}`}
                      >
                        <Download size={15} />
                        下载JPEG
                      </a>
                    )}
                  </div>
                  <p className="hint">影片主视觉与片名统一，保留平台安全区。</p>
                  {p.coverVersions.length > 1 && (
                    <details>
                      <summary>历史封面（{p.coverVersions.length}）</summary>
                      {[...p.coverVersions].reverse().map((f) => (
                        <a
                          key={f}
                          href={media(f)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            className="version-cover"
                            src={media(f)}
                            alt="历史封面"
                          />
                        </a>
                      ))}
                    </details>
                  )}
                </section>
              </div>
            )}
            {!job && jobs.length > 0 && (
              <details className="job-history">
                <summary>最近制作记录 · {jobs[0].message}</summary>
                {jobs.slice(0, 8).map((j) => (
                  <p key={j.id}>
                    {j.status === "completed" ? (
                      <Check size={14} />
                    ) : (
                      <Square size={14} />
                    )}{" "}
                    {j.scope} · {j.message}
                  </p>
                ))}
              </details>
            )}
          </section>
        )}
      </main>
      {modal && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-title"
            className="modal"
          >
            <button
              className="close"
              onClick={() => setModal(false)}
              aria-label="关闭新建"
            >
              ×
            </button>
            <p className="eyebrow">从一个主题开始</p>
            <h2 id="new-title">新的历史故事</h2>
            <p className="hint">
              输入主题，一键生成完整短片。生成后仍可逐镜修改。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                const submitter = (e.nativeEvent as SubmitEvent)
                  .submitter as HTMLButtonElement;
                act(async () => {
                  let project = await api<FilmProject>("/projects", {
                    method: "POST",
                    body: JSON.stringify({
                      topic: form.get("topic"),
                      type: form.get("type"),
                      focus: form.get("focus"),
                      officialUrls: String(form.get("urls") || "")
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }),
                  });
                  const photos = form
                    .getAll("photos")
                    .filter((x) => x instanceof File && x.size) as File[];
                  let uploadError = "";
                  for (const photo of photos) {
                    try {
                      const uploadForm = new FormData();
                      uploadForm.append("image", photo);
                      project = await api<FilmProject>(
                        "/projects/" + project.id + "/upload",
                        { method: "POST", body: uploadForm },
                      );
                    } catch (e) {
                      uploadError = (e as Error).message;
                      break;
                    }
                  }
                  await open(project);
                  setModal(false);
                  await refreshList();
                  if (uploadError) {
                    setError(
                      "项目已创建，但参考照片上传失败，请在内容页重新添加：" +
                        uploadError,
                    );
                    return;
                  }
                  if (submitter.value === "generate") {
                    const j = await api<Job>(
                      "/projects/" + project.id + "/jobs",
                      {
                        method: "POST",
                        body: JSON.stringify({ scope: "full" }),
                      },
                    );
                    setJobs([j]);
                    setP({ ...project, status: "running" });
                  }
                });
              }}
            >
              <label>
                主题名称
                <input
                  name="topic"
                  required
                  maxLength={160}
                  placeholder="例如：佛光寺东大殿、陕西历史博物馆"
                />
              </label>
              <label>
                题材类型
                <select name="type">
                  <option value="building">历史建筑</option>
                  <option value="museum">博物馆</option>
                  <option value="site">遗址</option>
                </select>
              </label>
              <label>
                希望讲述什么
                <textarea
                  name="focus"
                  placeholder="一个结构之谜，一件器物的来历，或一段历史故事"
                />
              </label>
              <label>
                官网 / 参考资料链接
                <textarea name="urls" placeholder="可选，每行一个链接" />
              </label>
              <label>
                参考照片
                <input
                  name="photos"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                />
              </label>
              <div className="modal-footer">
                <span>竖屏 · 约72秒 · 中文旁白</span>
                <div className="actions">
                  <button type="submit" value="create" disabled={busy}>
                    仅创建
                  </button>
                  <button
                    type="submit"
                    value="generate"
                    className="primary"
                    disabled={busy || missing.length > 0}
                  >
                    <Play size={16} />
                    创建并制作
                  </button>
                </div>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
