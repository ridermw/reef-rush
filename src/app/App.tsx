import { useState, useSyncExternalStore } from 'react';
import { COURSES, COURSE_NAMES } from '../content/courses/courseIds';
import {
  canRetryCourse,
  type AppPresentation,
  type AppStore,
} from './appStore';
import { screenUsesGameRoot, type AppScreen } from './screens';
import { CourseSelectScreen } from './components/CourseSelectScreen';
import { ErrorScreen } from './components/ErrorScreen';
import { GameHud } from './components/GameHud';
import { LoadingScreen } from './components/LoadingScreen';
import { PauseScreen } from './components/PauseScreen';
import { ResultsScreen } from './components/ResultsScreen';
import { TitleScreen } from './components/TitleScreen';
import { unlockedCourseIds } from '../game/progression/progress';
import type { GameHost } from '../game/core/GameHost';
import {
  createSettingsStore,
  type SettingsStore,
} from '../settings/SettingsStore';
import { SettingsDialog } from './components/SettingsDialog';
import { SavedProgressDialog } from './components/SavedProgressDialog';
import { DiagnosticsDialog } from './components/DiagnosticsDialog';
import { AudioNotice, type ShellAudio } from './components/AudioNotice';

export interface AppProps {
  store: AppStore;
  settings?: SettingsStore;
  host?: Pick<
    GameHost,
    | 'setContainer'
    | 'setSettingsOpen'
    | 'settings'
    | 'retryCourse'
    | 'inspectSavedProgress'
    | 'replaceSavedProgress'
    | 'retrySaving'
    | 'getDiagnostics'
  > &
    ShellAudio;
}

const fallbackPresentation: AppPresentation = {
  elapsedMs: 0,
  dashRatio: 1,
  checkpointIndex: 0,
  checkpointCount: 0,
  pearlCount: 0,
};

export function App({ store, host, settings }: AppProps) {
  const [preferences] = useState(
    () => settings ?? host?.settings ?? createSettingsStore(),
  );
  const [modal, setModal] = useState<
    | { kind: 'settings' }
    | { kind: 'progress' | 'diagnostics'; screen: AppScreen }
    | null
  >(null);
  const preferencesState = useSyncExternalStore(
    preferences.subscribe,
    preferences.getState,
    preferences.getState,
  );
  function openSettings() {
    host?.setSettingsOpen(true);
    setModal({ kind: 'settings' });
  }
  function resume() {
    void host?.unlockAudio();
    store.dispatch({ type: 'RESUME' });
  }
  function retryCourse() {
    if (host) host.retryCourse();
    else store.dispatch({ type: 'RETRY_COURSE' });
  }
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  if (modal && modal.kind !== 'settings' && modal.screen !== state.screen) {
    setModal(null);
  }
  const courseName = state.selectedCourseId
    ? COURSE_NAMES[state.selectedCourseId]
    : null;
  const presentation = state.presentation ?? fallbackPresentation;
  const progressNotice = state.progressNotice ? (
    <p className="progress-notice" role="status">
      {state.progressNotice}
    </p>
  ) : null;

  const content = (() => {
    switch (state.screen) {
      case 'title':
        return (
          <TitleScreen
            onDiveIn={() => store.dispatch({ type: 'OPEN_COURSE_SELECT' })}
            onSettings={openSettings}
          />
        );

      case 'course-select':
        return (
          <CourseSelectScreen
            courses={COURSES}
            unlockedCourseIds={
              state.progress
                ? unlockedCourseIds(state.progress)
                : ['sunlit-shoals']
            }
            onBack={() => store.dispatch({ type: 'RETURN_TO_TITLE' })}
            onSelectCourse={(courseId) => {
              store.dispatch({ type: 'LOAD_COURSE', courseId });
              void host?.unlockAudio();
            }}
          />
        );

      case 'loading':
        return (
          <LoadingScreen
            courseName={courseName ?? 'the next Reef Rush run'}
            onCancel={() => store.dispatch({ type: 'RETURN_TO_TITLE' })}
          />
        );

      case 'playing':
        return (
          <GameHud
            courseName={courseName ?? 'Open water'}
            onPause={() => store.dispatch({ type: 'PAUSE' })}
            presentation={presentation}
          />
        );

      case 'paused':
        return (
          <>
            <GameHud
              courseName={courseName ?? 'Open water'}
              onPause={resume}
              presentation={presentation}
              pauseLabel="Resume run"
              pauseDisabled={state.graphicsLost}
            />
            <PauseScreen
              courseName={courseName ?? 'Current course'}
              onResume={resume}
              graphicsLost={state.graphicsLost}
              onRetryCourse={retryCourse}
              onSettings={openSettings}
              onReturnToTitle={() =>
                store.dispatch({ type: 'RETURN_TO_TITLE' })
              }
            />
          </>
        );

      case 'results':
        if (!state.result)
          throw new Error('Results screen requires a finished race result.');
        return (
          <ResultsScreen
            courseName={courseName ?? 'Completed course'}
            result={state.result}
            achievements={state.achievements}
            onRaceAgain={() => {
              store.dispatch({ type: 'REPLAY' });
              void host?.unlockAudio();
            }}
            onChooseCourse={() =>
              store.dispatch({ type: 'OPEN_COURSE_SELECT' })
            }
            onReturnToTitle={() => store.dispatch({ type: 'RETURN_TO_TITLE' })}
          />
        );

      case 'error':
        return (
          <ErrorScreen
            detail={
              state.error?.detail ??
              'This expedition could not continue. Return to title to try again.'
            }
            title={state.error?.title ?? 'Run unavailable'}
            onRetryCourse={canRetryCourse(state) ? retryCourse : undefined}
            onReturnToTitle={() => store.dispatch({ type: 'RETURN_TO_TITLE' })}
          />
        );
    }
  })();
  const stationary = state.screen !== 'playing' && state.screen !== 'loading';
  const modalContent =
    modal?.kind === 'settings' ? (
      <SettingsDialog
        store={preferences}
        audio={host}
        onModalChange={host?.setSettingsOpen}
        onClose={() => setModal(null)}
      />
    ) : modal?.kind === 'progress' && host && stationary ? (
      <SavedProgressDialog host={host} onClose={() => setModal(null)} />
    ) : modal?.kind === 'diagnostics' && host && stationary ? (
      <DiagnosticsDialog host={host} onClose={() => setModal(null)} />
    ) : null;
  const notices = (
    <>
      {progressNotice}
      {host && stationary && (
        <div className="stationary-utilities">
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              host.setSettingsOpen(true);
              setModal({ kind: 'progress', screen: state.screen });
            }}
          >
            Saved progress
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              host.setSettingsOpen(true);
              setModal({ kind: 'diagnostics', screen: state.screen });
            }}
          >
            Diagnostics
          </button>
        </div>
      )}
      {state.graphicsLost && (
        <p className="service-notice" role="status">
          Graphics interrupted. Waiting for graphics to be restored; your run
          and saved progress are retained. Restoration will not resume play.
        </p>
      )}
      {!modal && preferencesState.notice && (
        <p className="service-notice" role="alert">
          {preferencesState.notice}
        </p>
      )}
      {!modal && host && <AudioNotice host={host} />}
    </>
  );

  if (screenUsesGameRoot(state.screen)) {
    return (
      <div
        className="app-shell app-shell--runtime"
        data-reduced-effects={preferencesState.settings.reducedMotion}
      >
        <div className="runtime-stage">
          <div
            aria-label="Gameplay render surface"
            className="game-root"
            id="game-root"
            ref={host?.setContainer}
          />
          <div className="runtime-overlay">
            {content}
            <div
              className="visually-hidden"
              role="log"
              aria-label="Race updates"
              aria-live="polite"
              aria-atomic="true"
            >
              {presentation.feedback?.announcement && (
                <span key={presentation.feedback.sequence}>
                  {presentation.feedback.announcement}
                </span>
              )}
            </div>
            {notices}
          </div>
          {modalContent}
        </div>
      </div>
    );
  }

  return (
    <div
      className="app-shell"
      data-reduced-effects={preferencesState.settings.reducedMotion}
    >
      {content}
      {notices}
      {modalContent}
    </div>
  );
}
