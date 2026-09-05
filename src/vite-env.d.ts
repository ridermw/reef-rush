/// <reference types="vite/client" />

declare module '*.css';

interface ImportMetaEnv {
  readonly VITE_TEST_HOOKS?: string;
}

interface Window {
  __REEF_RUSH_TEST__?: import('./game/core/exposeGameHost').ReefRushTestHook;
}
