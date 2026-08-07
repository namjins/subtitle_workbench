#!/usr/bin/env node
import { createLocalBridgeServer } from "../lib/local-bridge-server.mjs";

const port = Number(process.env.SUBTITLE_WORKBENCH_BRIDGE_PORT ?? process.argv[2] ?? 8765);
const host = process.env.SUBTITLE_WORKBENCH_BRIDGE_HOST ?? "127.0.0.1";

const server = createLocalBridgeServer();

server.listen(port, host, () => {
  process.stderr.write(`Subtitle Workbench local bridge listening on http://${host}:${port}\n`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
