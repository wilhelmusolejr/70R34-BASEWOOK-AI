/**
 * BASEWOOK Chat Agent — Translate natural language into a tasks.json and optionally run it.
 *
 * Usage: node chat.js
 *        npm run chat
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { nlToJson } = require('./chat/nlToJson');

const TASKS_PATH = path.join(__dirname, 'tasks.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function printTask(task) {
  console.log('\n--- Generated Task ---');
  console.log(JSON.stringify(task, null, 2));
  console.log('----------------------\n');
}

async function main() {
  console.log('BASEWOOK Chat Agent');
  console.log('Describe what you want to automate and the agent will build the task JSON.');
  console.log('Type "exit" to quit.\n');

  while (true) {
    const input = await ask('You: ');

    if (!input.trim()) continue;
    if (input.trim().toLowerCase() === 'exit') break;

    console.log('\nGenerating task...');

    let task;
    try {
      task = await nlToJson(input.trim());
    } catch (err) {
      console.error(`Error: ${err.message}\n`);
      continue;
    }

    printTask(task);

    const confirm = await ask('Write this to tasks.json? (y/n): ');
    if (confirm.trim().toLowerCase() === 'y') {
      fs.writeFileSync(TASKS_PATH, JSON.stringify(task, null, 2));
      console.log(`Saved to tasks.json. Run "npm run task" to execute.\n`);
    } else {
      console.log('Discarded. Try again.\n');
    }
  }

  rl.close();
  console.log('Bye.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
