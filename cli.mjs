#!/usr/bin/env node
// Node 22.18+ runs TypeScript itself; older versions load it through tsx
const tsx = () =>
  import("tsx/esm/api").catch(() => {
    throw new Error(`Node ${process.version} cannot run TypeScript: use Node 22.18 or later, or install tsx.`);
  });

if (!process.features.typescript) (await tsx()).register();
const { run } = await import(new URL("./cli.mts", import.meta.url).href);
await run(process.argv.slice(2));
