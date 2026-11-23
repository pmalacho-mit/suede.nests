// Calls memory.ts's parseMemory from another file, as code using a function
// does: where the editor plugin's hover and inlay hints are read.
import { parseMemory } from "./memory.ts";

export const round = (n: number) => Math.round(n);

export const sizes = () => [
  parseMemory("8g"),
  parseMemory("lots"),
  parseMemory("16g"),
  round(1.5),
];
