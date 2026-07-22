/**
 * npm run demo
 *
 * Starts the demo UI. The agent runs inside this process, so the API key is read
 * here and stays here. The browser only ever talks to this server.
 *
 * Override the port with PORT=4000 npm run demo.
 */

import { loadEnv } from "../src/agent/config.js";
import { startServer } from "../src/server/server.js";

loadEnv();

const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`PORT must be a positive whole number, got "${process.env.PORT}".`);
}

startServer(port);
