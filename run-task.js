/**
 * Run a task file without needing the server.
 *
 * Usage:
 *   node run-task.js [task-file]
 *
 * Defaults to tasks.json.
 */

const fs = require('fs');
const path = require('path');
const { runTask } = require('./runner');

// Crash diagnostics — modern Node (15+) kills the process on unhandled
// rejections by default. If that happens inside a patched console.log path,
// the underlying error can get swallowed and the process just exits. These
// handlers force the actual cause to be printed before exit.
process.on('unhandledRejection', (reason) => {
  console.error('\n!!! UNHANDLED REJECTION — bot is about to die:');
  console.error(reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('\n!!! UNCAUGHT EXCEPTION — bot is about to die:');
  console.error(err && err.stack ? err.stack : err);
});
process.on('exit', (code) => {
  if (code !== 0) console.error(`\n!!! process exiting with code ${code}`);
});

function loadTask(fileArg) {
  const taskFile = path.resolve(process.cwd(), fileArg || 'tasks.json');
  if (!fs.existsSync(taskFile)) {
    throw new Error(
      `Task file not found: ${taskFile}\nPass a task file, for example: node run-task.js "tasks copy.json"`
    );
  }

  try {
    return JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read task file ${taskFile}: ${err.message}`);
  }
}

async function main() {
  try {
    const task = loadTask(process.argv[2]);
    const result = await runTask(task);
    console.log('\nResult:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Task failed:', err.message);
    process.exitCode = 1;
  }
}

main();
