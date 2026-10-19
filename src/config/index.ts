import { coreSettings } from "./core-settings.js";
import { serviceSettings } from "./service-settings.js";
export type { StellarNetwork } from "./stellar.js";

export const config = {
  ...coreSettings,
  ...serviceSettings,
} as const;
