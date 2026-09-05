const controls = [
  { input: 'W / S', action: 'Throttle: increase / reduce forward speed' },
  { input: 'A / D or Left / Right', action: 'Steer horizontally' },
  {
    input: 'Up / Down or mouse',
    action: 'Pitch; mouse also steers horizontally',
  },
  { input: 'Space', action: 'Dash using boost reserve' },
  { input: 'Left Shift', action: 'Feather speed for tight corners' },
  { input: 'Esc', action: 'Pause / resume' },
];

export interface TitleScreenProps {
  onDiveIn: () => void;
  onSettings: () => void;
}

export function TitleScreen({ onDiveIn, onSettings }: TitleScreenProps) {
  return (
    <main className="screen screen--title">
      <section className="hero-panel">
        <div className="title-masthead">
          <p className="eyebrow">A small ocean. A grand expedition.</p>
          <span className="edition-mark">Field guide / 01</span>
        </div>
        <div className="hero-copy">
          <div className="hero-story">
            <p className="wordmark-kicker">Find your flow.</p>
            <h1 className="wordmark">
              Reef <em>Rush</em>
            </h1>
            <p className="hero-pitch">
              Slip through sunlit coral, follow the pearl trail, and find the
              cleanest line home. Every little second is an adventure.
            </p>
          </div>
          <div className="expedition-seal" aria-hidden="true">
            <svg viewBox="0 0 300 240" fill="none">
              <ellipse cx="150" cy="120" rx="133" ry="96" />
              <ellipse
                cx="150"
                cy="120"
                rx="116"
                ry="79"
                strokeDasharray="2 8"
              />
              <path d="M18 160C72 119 94 203 155 169S242 124 286 147M16 178C78 137 98 222 167 185S247 144 287 165" />
              <path
                className="seal-fish"
                d="M91 119C124 69 184 72 214 118C184 160 124 164 91 119ZM92 119L60 91L66 146Z"
              />
              <path d="M155 89L137 63L185 86M156 150L141 172L186 147" />
              <circle cx="192" cy="111" r="4" className="seal-eye" />
              <path d="M146 104Q157 120 146 134" />
              <circle cx="231" cy="75" r="5" />
              <circle cx="242" cy="57" r="3" />
            </svg>
            <span>Sunfin / Reef explorer</span>
          </div>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={onDiveIn} type="button">
            Dive in
          </button>
          <button
            className="secondary-button"
            onClick={onSettings}
            type="button"
          >
            Settings
          </button>
          <p className="hero-meta">
            Solo time trials
            <br />
            Made for keyboard &amp; mouse
          </p>
        </div>
      </section>

      <section aria-labelledby="controls-heading" className="info-panel">
        <div className="panel-heading">
          <h2 id="controls-heading">Controls at a glance</h2>
          <p>
            Move the pointer over the water to steer. Leaving the window pauses
            the run.
          </p>
        </div>
        <dl className="controls-grid">
          {controls.map((control) => (
            <div className="controls-row" key={control.input}>
              <dt>{control.input}</dt>
              <dd>{control.action}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
