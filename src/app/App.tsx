import { useSyncExternalStore } from 'react';
import { COURSES, COURSE_NAMES } from '../content/courses/courseIds';
import type { AppPresentation, AppStore } from './appStore';
import { screenUsesGameRoot } from './screens';
import { CourseSelectScreen } from './components/CourseSelectScreen';
import { ErrorScreen } from './components/ErrorScreen';
import { GameHud } from './components/GameHud';
import { LoadingScreen } from './components/LoadingScreen';
import { PauseScreen } from './components/PauseScreen';
import { ResultsScreen } from './components/ResultsScreen';
import { TitleScreen } from './components/TitleScreen';
import { unlockedCourseIds } from '../game/progression/progress';
import type { GameHost } from '../game/core/GameHost';

export interface AppProps {
  store: AppStore;
  host?: Pick<GameHost, 'setContainer'>;
}

const fallbackPresentation: AppPresentation = {
  elapsedMs: 0,
  dashRatio: 1,
  checkpointIndex: 0,
  checkpointCount: 0,
  pearlCount: 0,
};

export function App({ store, host }: AppProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
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
            onSelectCourse={(courseId) =>
              store.dispatch({ type: 'LOAD_COURSE', courseId })
            }
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
              onPause={() => store.dispatch({ type: 'RESUME' })}
              presentation={presentation}
              pauseLabel="Resume run"
            />
            <PauseScreen
              courseName={courseName ?? 'Current course'}
              onResume={() => store.dispatch({ type: 'RESUME' })}
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
            onReturnToTitle={() => store.dispatch({ type: 'RETURN_TO_TITLE' })}
          />
        );

      case 'error':
        return (
          <ErrorScreen
            detail={state.error?.detail ?? 'An unknown shell error occurred.'}
            title={state.error?.title ?? 'Unexpected shell state'}
            onReturnToTitle={() => store.dispatch({ type: 'RETURN_TO_TITLE' })}
          />
        );
    }
  })();

  if (screenUsesGameRoot(state.screen)) {
    return (
      <div className="app-shell app-shell--runtime">
        <div className="runtime-stage">
          <div
            aria-label="Gameplay render surface"
            className="game-root"
            id="game-root"
            ref={host?.setContainer}
          />
          <div className="runtime-overlay">
            {content}
            {progressNotice}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {content}
      {progressNotice}
    </div>
  );
}
