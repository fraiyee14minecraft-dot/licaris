import type { LauncherSettings } from "../types/launcher";

export interface JavaMemoryArguments {
  xms: string;
  xmx: string;
  args: string[];
}

export function createJavaMemoryArguments(settings: LauncherSettings): JavaMemoryArguments {
  // Reserving the whole selected heap up front competes with Windows, the GPU
  // driver and native game allocations without improving the maximum heap.
  // Two gigabytes are enough for bootstrap; the JVM can then grow up to Xmx as
  // the pack actually needs it.
  const xms = "-Xms2G";
  const xmx = `-Xmx${settings.ramGb}G`;

  return {
    xms,
    xmx,
    args: [xms, xmx]
  };
}
