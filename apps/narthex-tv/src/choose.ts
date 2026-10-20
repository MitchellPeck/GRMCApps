/**
 * Which of the schedule entries covering this moment gets the screen.
 *
 * They arrive best first. The first whose playlist exists, is not archived,
 * and has something to show plays. If none does, nothing plays -- the TV is
 * still on, because power follows the schedule -- and the first live playlist
 * is named so the admin screen can say which one is empty.
 *
 * Indexes into `candidates`; null = none.
 */
export function choosePlaying(
  candidates: Array<{ playlist: { archived: boolean } | null; frameCount: number }>
): { playing: number | null; named: number | null; nothingPlayable: boolean } {
  let named: number | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const { playlist, frameCount } = candidates[i];
    if (!playlist || playlist.archived) continue;
    if (named === null) named = i;
    if (frameCount > 0) return { playing: i, named: i, nothingPlayable: false };
  }
  return { playing: null, named, nothingPlayable: candidates.length > 0 };
}
