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

export interface AppProps {
  store: AppStore;
}

const fallbackPresentation: AppPresentation = {
  elapsedMs: 0,
  dashRatio: 1,
  checkpointIndex: 0,
  checkpointCount: 0,
  pearlCount: 0,
};

export function App({ store }: AppProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const courseName = state.selectedCourseId
    ? COURSE_NAMES[state.selectedCourseId]
    : null;
  const presentation = state.presentation ?? fallbackPresentation;

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
            onBack={() => store.dispatch({ type: 'RETURN_TO_TITLE' })}
            onSelectCourse={(courseId) =>
              store.dispatch({ type: 'LOAD_COURSE', courseId })
            }
          />
        );

      case 'loading':
        return (
          <LoadingScreen courseName={courseName ?? 'the next Reef Rush run'} />
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
        return (
          <ResultsScreen
            courseName={courseName ?? 'Completed course'}
            elapsedMs={state.result?.elapsedMs ?? presentation.elapsedMs}
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
          />
          <div className="runtime-overlay">{content}</div>
        </div>
      </div>
    );
  }

  return <div className="app-shell">{content}</div>;
}
