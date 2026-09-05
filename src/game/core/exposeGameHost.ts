import type { HostSnapshot } from './GameHost';

export interface InputStamp {
  readonly screen: HostSnapshot['screen'];
  readonly steps: number;
  readonly rendered: number;
  readonly settingsOpen: boolean;
  readonly graphicsLost: boolean;
  readonly inputResets: number;
}

export interface ReefRushTestHook {
  readonly getSnapshot: () => HostSnapshot;
  readonly getInputStamp: () => InputStamp;
}

export function exposeGameHost(
  getSnapshot: () => HostSnapshot,
  getInputStamp: () => InputStamp,
): () => void {
  const hook: ReefRushTestHook = Object.freeze({ getSnapshot, getInputStamp });
  window.__REEF_RUSH_TEST__ = hook;
  return () => {
    if (window.__REEF_RUSH_TEST__ === hook) delete window.__REEF_RUSH_TEST__;
  };
}
