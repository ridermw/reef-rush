import type { FinishedRaceResult } from '../../game/race/raceTypes';

function formatElapsedMs(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((elapsedMs % 1000) / 10);

  return `${minutes}:${seconds.toString().padStart(2, '0')}.${centiseconds
    .toString()
    .padStart(2, '0')}`;
}

export interface ResultsScreenProps {
  courseName: string;
  result: FinishedRaceResult;
  onReturnToTitle: () => void;
}

export function ResultsScreen({
  courseName,
  result,
  onReturnToTitle,
}: ResultsScreenProps) {
  return (
    <section className="overlay-card overlay-card--modal">
      <p className="eyebrow">Run complete</p>
      <h2>{courseName}</h2>
      <p className="results-time">{formatElapsedMs(result.elapsedMs)}</p>
      <p>{result.medal ? `${result.medal} medal` : 'No medal this run'}</p>
      <p>
        {result.pearlCount} / {result.totalPearls} pearls
      </p>
      <button
        className="primary-button"
        onClick={onReturnToTitle}
        type="button"
      >
        Return to title
      </button>
    </section>
  );
}
