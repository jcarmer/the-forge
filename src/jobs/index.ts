import type { AnyJob } from "../schedule/registry.js";
import { scanNodeModulesJob } from "./scanNodeModules.js";

/** Every function the scheduler can run. Add a `defineJob(...)` module and list it here; the UI picks it up. */
export const JOBS: AnyJob[] = [scanNodeModulesJob as AnyJob];
