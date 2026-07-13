#!/usr/bin/env node
import type { Writable } from "node:stream";
import { runMain } from "citty";
import { main } from "./main.js";
import { installEpipeHandler } from "./ui/epipe.js";

// `cc-hindsight list | head` closes our stdout mid-write. That's normal Unix
// life, not an error: exit quietly like cat/grep/ls do instead of dumping an
// EPIPE stack trace on the customer. stderr can close the same way.
installEpipeHandler(process.stdout as unknown as Writable);
installEpipeHandler(process.stderr as unknown as Writable);

await runMain(main);
