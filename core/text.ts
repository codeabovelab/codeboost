/** Cut to at most `max` UTF-16 units (the unit every length bound here counts), never inside a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  if (/[\ud800-\udbff]/.test(text[end - 1] ?? '')) end--;
  return `${text.slice(0, end)}…`;
}
