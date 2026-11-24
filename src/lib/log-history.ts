import type { AppEvent } from "./types";

// Match the desktop core's in-memory history window.
const limit = 2000;

export function mergeLogEvents(current: AppEvent[], incoming: AppEvent[]) {
  if (!incoming.length) return current;
  if (
    incoming.length === 1 &&
    incoming[0].sequence > (current.at(-1)?.sequence ?? 0)
  ) {
    return [
      ...(current.length === limit ? current.slice(1) : current),
      incoming[0],
    ];
  }
  const events = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) events.set(event.sequence, event);
  return [...events.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-limit);
}
