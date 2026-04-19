/**
 * Run a task from tasks.json without needing the server.
 *
 * Usage: node run-task.js
 */

const { runTask } = require('./runner');
const task = require('./tasks.json');

async function main() {
  try {
    const result = await runTask(task);
    console.log('\nResult:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Task failed:', err.message);
    process.exitCode = 1;
  }
}

main();
