export interface ErrorScreenProps {
  title: string;
  detail: string;
  onReturnToTitle: () => void;
}

export function ErrorScreen({
  title,
  detail,
  onReturnToTitle,
}: ErrorScreenProps) {
  return (
    <main className="screen screen--error">
      <section className="overlay-card overlay-card--error">
        <p className="eyebrow">A change of tide</p>
        <h1>{title}</h1>
        <p>{detail}</p>
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
