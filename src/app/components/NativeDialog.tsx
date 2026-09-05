import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

interface NativeDialogProps {
  labelledBy: string;
  describedBy: string;
  onClose: () => void;
  onModalChange?: (open: boolean) => void;
  children: ReactNode;
}

export function NativeDialog({
  labelledBy,
  describedBy,
  onClose,
  onModalChange,
  children,
}: NativeDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) throw new Error('Dialog is not mounted.');
    const opener = document.activeElement;
    onModalChange?.(true);
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    return () => {
      dialog.close();
      onModalChange?.(false);
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, [onModalChange]);

  function ownKeyboard(event: KeyboardEvent<HTMLDialogElement>) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab') {
      const controls = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = controls[0];
      const last = controls.at(-1);
      const focus = document.activeElement;
      if (
        event.shiftKey
          ? focus === first || focus === event.currentTarget
          : focus === last || focus === event.currentTarget
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
  }

  return (
    <dialog
      ref={ref}
      className="settings-dialog"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={-1}
      onKeyDown={ownKeyboard}
      onKeyUp={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
