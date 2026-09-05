const MAX_NODES = 32;
const MAX_MESSAGE_LENGTH = 512;
const MAX_DETAIL_LENGTH = 2048;
const OMITTED = '[additional error detail omitted]';

export function errorDetail(error: unknown): string {
  const pending: unknown[] = [];
  const seen = new Set<unknown>();
  const messages = new Set<string>();
  let omitted = false;

  function enqueue(value: unknown): void {
    if (seen.has(value)) return;
    if (pending.length === MAX_NODES) {
      omitted = true;
      return;
    }
    seen.add(value);
    pending.push(value);
  }

  enqueue(error);
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index];
    const text = current instanceof Error ? current.message : String(current);
    if (text.length > MAX_MESSAGE_LENGTH) omitted = true;
    if (text) messages.add(text.slice(0, MAX_MESSAGE_LENGTH));
    if (!(current instanceof Error)) continue;
    if (current.cause !== undefined) enqueue(current.cause);
    if (current instanceof AggregateError) {
      const children: unknown[] = current.errors;
      // Retained construction errors append retries; keep recent failures visible.
      const first = Math.max(0, children.length - MAX_NODES);
      if (first > 0) omitted = true;
      for (let child = children.length - 1; child >= first; child--)
        enqueue(children[child]);
    }
  }
  const detail = [...messages].join('; ') || 'Unspecified error.';
  if (!omitted && detail.length <= MAX_DETAIL_LENGTH) return detail;
  return `${detail.slice(0, MAX_DETAIL_LENGTH - OMITTED.length - 1)} ${OMITTED}`;
}
