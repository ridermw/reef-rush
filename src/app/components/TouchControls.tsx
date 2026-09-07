import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { TouchInput, type TouchAction } from '../../game/input/TouchInput';

type Control = TouchAction | 'steer' | 'dash';
type Capture = { element: HTMLButtonElement; pointerId: number };
const actions: ReadonlyArray<readonly [TouchAction, string]> = [
  ['faster', 'Faster'],
  ['slower', 'Slower'],
  ['brake', 'Brake'],
];

export function TouchControls({ input }: { input: TouchInput }) {
  const captures = useRef(new Map<Control, Capture>());
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [held, setHeld] = useState<ReadonlySet<Control>>(new Set());

  useEffect(() => {
    const owned = captures.current;
    const releaseAll = () => {
      const previous = [...owned.values()];
      owned.clear();
      for (const { element, pointerId } of previous) {
        if (element.hasPointerCapture(pointerId))
          element.releasePointerCapture(pointerId);
      }
      setPosition({ x: 0, y: 0 });
      setHeld(new Set());
    };
    const unsubscribe = input.subscribeReset(releaseAll);
    window.addEventListener('blur', input.clear);
    window.addEventListener('resize', input.clear);
    window.addEventListener('orientationchange', input.clear);
    window.visualViewport?.addEventListener('resize', input.clear);
    return () => {
      unsubscribe();
      window.removeEventListener('blur', input.clear);
      window.removeEventListener('resize', input.clear);
      window.removeEventListener('orientationchange', input.clear);
      window.visualViewport?.removeEventListener('resize', input.clear);
      input.clear();
      releaseAll();
    };
  }, [input]);

  function steer(event: PointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      input.clear();
      return;
    }
    const x = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    const y = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2);
    input.setSteering(x, y);
    setPosition({
      x: Math.max(-1, Math.min(1, x)),
      y: Math.max(-1, Math.min(1, y)),
    });
  }

  function start(control: Control, event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || captures.current.has(control)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    captures.current.set(control, {
      element: event.currentTarget,
      pointerId: event.pointerId,
    });
    setHeld((previous) => new Set([...previous, control]));
    if (control === 'steer') steer(event);
    else if (control === 'dash') input.queueDash();
    else input.setAction(control, true);
  }

  function end(control: Control, event: PointerEvent<HTMLButtonElement>) {
    const capture = captures.current.get(control);
    if (capture?.pointerId !== event.pointerId) return;
    captures.current.delete(control);
    if (capture.element.hasPointerCapture(event.pointerId))
      capture.element.releasePointerCapture(event.pointerId);
    setHeld(
      (previous) => new Set([...previous].filter((key) => key !== control)),
    );
    if (control === 'steer') {
      input.setSteering(0, 0);
      setPosition({ x: 0, y: 0 });
    } else if (control === 'dash') {
      if (event.type !== 'pointerup') input.cancelPendingDash();
    } else input.setAction(control, false);
  }

  return (
    <div
      className="touch-controls"
      role="group"
      aria-label="Touch controls"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="touch-steering">
        <button
          type="button"
          className="touch-pad"
          aria-label="Steer fish"
          aria-describedby="touch-steering-help"
          onPointerDown={(event) => start('steer', event)}
          onPointerUp={(event) => end('steer', event)}
          onPointerCancel={(event) => end('steer', event)}
          onLostPointerCapture={(event) => end('steer', event)}
          onPointerMove={(event) => {
            if (captures.current.get('steer')?.pointerId === event.pointerId)
              steer(event);
          }}
        >
          <span className="touch-pad__cross" aria-hidden="true" />
          <span
            className="touch-pad__thumb"
            aria-hidden="true"
            style={{
              transform: `translate(${position.x * 32}px, ${position.y * 32}px)`,
            }}
          />
          <span className="touch-pad__label" aria-hidden="true">
            Steer
          </span>
        </button>
        <p id="touch-steering-help">Drag to turn. Auto-swim.</p>
      </div>
      <div className="touch-actions">
        <button
          type="button"
          className="primary-button touch-dash"
          onPointerDown={(event) => start('dash', event)}
          onPointerUp={(event) => end('dash', event)}
          onPointerCancel={(event) => end('dash', event)}
          onLostPointerCapture={(event) => end('dash', event)}
          onClick={(event) => {
            // Keyboard / assistive activation has no preceding pointer press.
            if (event.detail === 0) input.queueDash();
          }}
        >
          Dash
        </button>
        {actions.map(([action, label]) => (
          <button
            key={action}
            type="button"
            className={`secondary-button touch-${action}`}
            aria-pressed={held.has(action)}
            onPointerDown={(event) => start(action, event)}
            onPointerUp={(event) => end(action, event)}
            onPointerCancel={(event) => end(action, event)}
            onLostPointerCapture={(event) => end(action, event)}
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                input.setAction(action, true);
                setHeld((previous) => new Set([...previous, action]));
              }
            }}
            onKeyUp={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                input.setAction(action, false);
                setHeld(
                  (previous) =>
                    new Set([...previous].filter((key) => key !== action)),
                );
              }
            }}
            onBlur={() => {
              if (!captures.current.has(action)) {
                input.setAction(action, false);
                setHeld(
                  (previous) =>
                    new Set([...previous].filter((key) => key !== action)),
                );
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
