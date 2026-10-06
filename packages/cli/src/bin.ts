#!/usr/bin/env node
import { main } from './main.js';

const code = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env });
if (code !== undefined) process.exitCode = code;
