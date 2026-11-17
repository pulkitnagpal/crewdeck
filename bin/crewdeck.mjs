#!/usr/bin/env node
// Runs the TypeScript CLI directly (Node ≥ 22.18 strips types natively).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts'));
