#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runConformance } from './conformance.mjs';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
    console.log('node run-conformance.mjs <factory.mjs> <new-evidence-directory> <blender-executable>');
    process.exit(0);
}
if (args.length !== 3) {
    console.error('Expected factory, fresh evidence directory and independent Blender executable; use --help');
    process.exit(1);
}
const [factory, out, blender] = args.map(p => resolve(p));
if (existsSync(out)) {
    console.error('Evidence directory already exists');
    process.exit(1);
}
let report;
try {
    const bytes = readFileSync(factory), loaded = await import(pathToFileURL(factory).href);
    report = await runConformance({ createRuntime: loaded.createRuntime, outputDirectory: out, blenderPath: blender });
    report.factory = { path: factory, sha256: createHash('sha256').update(bytes).digest('hex') };
    writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, report: resolve(out, 'report.json'), checks: report.checks.length, failure: report.failure ?? report.cleanupFailure ?? null }));
}
catch (error) {
    console.error(error.message);
    process.exit(1);
}
process.exit(report.status === 'passed' ? 0 : 1);
