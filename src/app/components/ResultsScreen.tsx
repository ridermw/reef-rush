import type { FinishedRaceResult } from '../../game/race/raceTypes';
import type { FinishAchievements } from '../../game/progression/finishAchievements';
import { COURSES } from '../../content/courses/courseIds';
import { formatElapsedMs } from '../formatElapsedMs';

export interface ResultsScreenProps {
  courseName: string;
  result: FinishedRaceResult;
  achievements: FinishAchievements | null;
  onRaceAgain: () => void;
  onChooseCourse: () => void;
  onReturnToTitle: () => void;
}

export function ResultsScreen({
  courseName,
  result,
  achievements,
  onRaceAgain,
  onChooseCourse,
  onReturnToTitle,
}: ResultsScreenProps) {
  return (
    <section className="overlay-card overlay-card--modal results-card">
      <p className="eyebrow">Run complete</p>
      <h2>{courseName}</h2>
      <p className="results-time">{formatElapsedMs(result.elapsedMs)}</p>
      <p className="medal-badge" data-medal={result.medal ?? 'none'}>
        {result.medal ? `${result.medal} medal` : 'No medal this run'}
      </p>
      <p className="results-pearls">
        {result.pearlCount} / {result.totalPearls} pearls
      </p>
      {achievements && (
        <div className="results-achievements">
          {achievements.firstCompletion && (
            <p className="achievement-label">First expedition complete</p>
          )}
          {achievements.newTimeRecord && (
            <p className="achievement-label">New time record</p>
          )}
          <p>
            Best time:{' '}
            {formatElapsedMs(achievements.bestAtFinish.bestElapsedMs)}
          </p>
          <small>Based on progress known at the finish.</small>
          {achievements.newlyUnlocked.map((id) => {
            const course = COURSES.find((entry) => entry.id === id);
            return (
              <p key={id}>
                {course?.name}:{' '}
                {course?.available
                  ? 'unlocked'
                  : 'qualified - not yet available'}
              </p>
            );
          })}
        </div>
      )}
      <div className="button-row">
        <button className="primary-button" onClick={onRaceAgain} type="button">
          Race again
        </button>
        <button
          className="secondary-button"
          onClick={onChooseCourse}
          type="button"
        >
          Choose another course
        </button>
        <button className="text-button" onClick={onReturnToTitle} type="button">
          Return to title
        </button>
      </div>
    </section>
  );
}
