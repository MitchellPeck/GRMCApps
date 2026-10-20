/**
 * Whether the narthex TV should be on. One rule: if there is something to
 * play, it is on; if not, it is off. A schedule entry covering now counts even
 * when its playlist turns out to be empty -- power follows the schedule, not
 * the playlist's contents, so the two can never disagree about a boundary.
 */
export function desiredPower(
  scheduleOn: boolean,
  playNowActive: boolean,
  takeoverActive: boolean
): "on" | "off" {
  return scheduleOn || playNowActive || takeoverActive ? "on" : "off";
}
