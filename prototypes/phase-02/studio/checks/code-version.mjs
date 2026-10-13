// Is the studio you are using running the code that is on disk?
//   node checks/code-version.mjs [port]        (default 5173, the port `npm start` prints)
// Node keeps a module once it has loaded it, so an edited file only takes effect after a restart. This asks the
// running server what it loaded and compares it with the files as they are now. Exit code 1 if they differ.
import { codeVersion, sourceFiles } from '../runtime/code-version.mjs';

const port = process.argv[2] || process.env.WORKBENCH_PORT || '5173';
const disk = codeVersion();
console.log(`on disk now   ${disk.short}  (${disk.files} files)`);

let state;
try {
  state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
} catch (e) {
  console.log(`running       no studio answered on port ${port} (${String(e.message).slice(0, 80)})`);
  console.log('\nStart it with:  npm start        (live model)');
  console.log('                npm run start:stub  (no API calls)');
  process.exit(1);
}
const run = state.code;
if (!run) {
  console.log('running       this studio is older than the fingerprint: restart it to find out what it runs');
  process.exit(1);
}
console.log(`running       ${run.short}  (${run.files} files, started ${run.startedAt})`);
if (run.hash === disk.hash) {
  console.log('\nSame code. What you see in the studio is what is in these files.');
  process.exit(0);
}
console.log('\nDIFFERENT. The studio is still running the code it started with; the files have changed since.');
console.log('Stop it (Ctrl+C in its terminal) and start it again, then run this check once more.');
console.log(`Files covered: ${sourceFiles().join(', ')}`);
process.exit(1);
