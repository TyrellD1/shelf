/** Deterministic desaturated color per machine id, so a shelf stays grey-first. */
export function machineHue(machineId: string): number {
  let h = 2166136261;
  for (let i = 0; i < machineId.length; i++) {
    h ^= machineId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
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

export function machineColor(machineId: string): MachineColor {
  const hue = machineHue(machineId);
  return {
    hue,
    lightBg: `hsl(${hue} 38% 96%)`,
    lightBorder: `hsl(${hue} 30% 86%)`,
    darkBg: `hsl(${hue} 22% 15%)`,
    darkBorder: `hsl(${hue} 18% 26%)`,
    swatch: `hsl(${hue} 45% 62%)`,
  };
}
