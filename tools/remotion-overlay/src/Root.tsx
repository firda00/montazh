import React from 'react';
import {CalculateMetadataFunction, Composition} from 'remotion';
import {Reel} from './Reel';
import type {DesignJob} from './types';
import defaultJob from './defaultProps.json';

// Width/height/fps/duration come from the design job's timeline (inputProps), not from constants.
const calculateMetadata: CalculateMetadataFunction<DesignJob> = ({props}) => {
  const t = props.timeline;
  return {
    width: t.width,
    height: t.height,
    fps: t.fps,
    durationInFrames: Math.max(1, Math.round(t.duration * t.fps)),
    defaultCodec: 'h264',
    defaultPixelFormat: 'yuv420p',
  };
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Reel"
    component={Reel}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={600}
    defaultProps={defaultJob as unknown as DesignJob}
    calculateMetadata={calculateMetadata}
  />
);
