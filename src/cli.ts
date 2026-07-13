#!/usr/bin/env node
import { runMain } from "citty";
import { main } from "./main.js";

// `cc-hindsight list | head` closes our stdout mid-write. That's normal Unix
// life, not an error: exit quietly like cat/grep/ls do instead of dumping an
// EPIPE stack trace on the customer.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

await runMain(main);
