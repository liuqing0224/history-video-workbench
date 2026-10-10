import { diagnostics } from "../server/providers.mjs";
for (const d of await diagnostics())
  console.log(`${d.available ? "✓" : "✗"} ${d.label} · ${d.command}`);
