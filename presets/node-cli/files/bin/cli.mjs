#!/usr/bin/env node
// The installed binary. All behaviour is in src/cli.mjs, so it can be tested without a process.

import { main } from '../src/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
