export interface ErrorScreenProps {
  title: string;
  detail: string;
  onRetryCourse?: () => void;
  onReturnToTitle: () => void;
}

export function ErrorScreen({
  title,
  detail,
  onRetryCourse,
  onReturnToTitle,
}: ErrorScreenProps) {
  return (
    <main className="screen screen--error">
      <section className="overlay-card overlay-card--error">
        <p className="eyebrow">A change of tide</p>
        <h1>{title}</h1>
        <p>{detail}</p>
        <p>
          If this is a graphics problem, Reef Rush requires WebGL 2. Try a
          current desktop browser with hardware acceleration enabled.
        </p>
        {onRetryCourse && (
          <>
            <p>Retry restarts this attempt and preserves saved progress.</p>
            <button
              className="secondary-button"
              onClick={onRetryCourse}
              type="button"
            >
              Retry course
            </button>
          </>
        )}
        <button
          className="primary-button"
          onClick={onReturnToTitle}
          type="button"
        >
          Return to title
        </button>
      </section>
    </main>
  );
}
