import React from "react";
import { Composition, registerRoot } from "remotion";
import { Film, type FilmProps } from "./Film";
import { totalFrames, FPS } from "../shared/model.mjs";
const Root = () => (
  <Composition
    id="HistoryFilm"
    component={Film}
    width={1080}
    height={1920}
    fps={FPS}
    durationInFrames={2160}
    defaultProps={{ project: { shots: [] } as unknown as FilmProps["project"] }}
    calculateMetadata={({ props }) => ({
      durationInFrames: totalFrames(props.project),
    })}
  />
);
registerRoot(Root);
