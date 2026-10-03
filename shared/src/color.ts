/** Deterministic desaturated color per machine id, so a shelf stays grey-first. */
export function machineHue(machineId: string): number {
  let h = 2166136261;
  for (let i = 0; i < machineId.length; i++) {
    h ^= machineId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

/** Fewest evenly spaced hue slots; 45° apart is the closest two machines can get. */
const MIN_SLOTS = 8;

let lastKey: string | null = null;
let lastHues = new Map<string, number>();

/**
 * Hues for a set of machines that never collide. Each machine prefers the slot
 * nearest its own hash and takes the next free slot when that one is gone.
 * Ids are claimed in sorted order, so every surface given the same set agrees.
 */
export function machineHues(machineIds: Iterable<string>): Map<string, number> {
  const ids = [...new Set(machineIds)].sort();
  const key = ids.join("\u0000");
  if (key === lastKey) return lastHues;

  const slots = Math.max(MIN_SLOTS, ids.length);
  const step = 360 / slots;
  const taken = new Set<number>();
  const hues = new Map<string, number>();
  for (const id of ids) {
    let slot = Math.round(machineHue(id) / step) % slots;
    while (taken.has(slot)) slot = (slot + 1) % slots;
    taken.add(slot);
    hues.set(id, Math.round(slot * step));
  }
  lastKey = key;
  lastHues = hues;
  return hues;
}

export interface MachineColor {
  hue: number;
  /** Background tint for a list row. */
  lightBg: string;
  lightBorder: string;
  darkBg: string;
  darkBorder: string;
  swatch: string;
}

/**
 * Pass every machine on the shelf as `known` so this one gets a hue no other
 * machine has; an id outside that set falls back to its own hash.
 */
export function machineColor(machineId: string, known: Iterable<string> = []): MachineColor {
  const hue = machineHues(known).get(machineId) ?? machineHue(machineId);
  return {
    hue,
    lightBg: `hsl(${hue} 38% 96%)`,
    lightBorder: `hsl(${hue} 30% 86%)`,
    darkBg: `hsl(${hue} 22% 15%)`,
    darkBorder: `hsl(${hue} 18% 26%)`,
    swatch: `hsl(${hue} 45% 62%)`,
  };
}
