import React from "react";
import {
  AbsoluteFill,
  Img,
  Audio,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { timeline, FPS } from "../shared/model.mjs";
export type FilmProject = import("zod").infer<
  typeof import("../shared/model.mjs").projectSchema
>;
export type FilmProps = { project: FilmProject; mediaBase?: string };
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const url = (asset: string, base?: string) =>
  base ? base + asset : staticFile(asset);
const Scene = ({
  shot,
  frames,
  mediaBase,
}: {
  shot: FilmProject["shots"][number];
  frames: number;
  mediaBase?: string;
}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, frames], [1, shot.zoom], clamp);
  let offset = 8;
  const cues = shot.cues.map((c) => {
    const from = offset;
    offset += Math.ceil((c.duration + 0.22) * FPS);
    return { ...c, from };
  });
  const cue = cues.find(
    (c) => frame >= c.from && frame < c.from + c.duration * FPS + 3,
  );
  return (
    <AbsoluteFill style={{ background: "#121b17", overflow: "hidden" }}>
      {shot.image && (
        <>
          <Img
            src={url(shot.image, mediaBase)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: `${shot.focusX}% ${shot.focusY}%`,
              filter:
                shot.fit === "contain" ? "blur(32px) brightness(.42)" : "none",
              transform: `scale(${scale + 0.03})`,
            }}
          />
          {shot.fit === "contain" && (
            <Img
              src={url(shot.image, mediaBase)}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
                transform: `scale(${scale})`,
              }}
            />
          )}
        </>
      )}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg,rgba(7,16,12,.55),transparent 25%,transparent 60%,rgba(7,16,12,.88))",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 125,
          left: 72,
          right: 72,
          fontFamily: "PingFang SC,sans-serif",
          fontSize: 25,
          color: "#efe8d7",
          letterSpacing: 2,
        }}
      >
        {shot.kind === "fact"
          ? "历史依据"
          : shot.kind === "legend"
            ? "文献传说"
            : "场景艺术想象"}{" "}
        · {shot.title}
      </div>
      {cues.map((c, i) => (
        <Sequence
          key={i}
          from={c.from}
          durationInFrames={Math.ceil(c.duration * FPS) + 1}
        >
          <Audio src={url(c.audio, mediaBase)} volume={1} />
        </Sequence>
      ))}
      {cue && (
        <div
          style={{
            position: "absolute",
            bottom: 250,
            left: 85,
            right: 115,
            textAlign: "center",
            fontFamily: "PingFang SC,sans-serif",
            fontSize: 45,
            fontWeight: 500,
            lineHeight: 1.65,
            color: "#fff7e8",
            textShadow: "0 2px 8px #000,0 0 25px #000",
          }}
        >
          {cue.text}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          bottom: 145,
          left: 72,
          fontFamily: "PingFang SC,sans-serif",
          fontSize: 21,
          color: "#ded6c5",
        }}
      >
        AI视觉演绎 · 历史、传说与艺术想象
      </div>
      <AbsoluteFill
        style={{
          background: "#101813",
          opacity: interpolate(
            frame,
            [0, 9, Math.max(10, frames - 10), frames],
            [1, 0, 0, 1],
            clamp,
          ),
        }}
      />
    </AbsoluteFill>
  );
};
export const Film = ({ project, mediaBase }: FilmProps) => (
  <AbsoluteFill>
    {timeline(project).map((row) => (
      <Sequence
        key={row.shot.id}
        from={row.from}
        durationInFrames={row.frames}
        premountFor={30}
      >
        <Scene shot={row.shot} frames={row.frames} mediaBase={mediaBase} />
      </Sequence>
    ))}
    {project.ambience && (
      <Audio src={url(project.ambience, mediaBase)} loop volume={0.14} />
    )}
  </AbsoluteFill>
);
