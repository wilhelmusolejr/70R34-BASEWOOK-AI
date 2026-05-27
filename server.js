/**
 * Express server exposing POST /execute endpoint for task execution.
 * Tasks run in the background — POST returns 202 immediately.
 * GET /status/:taskId to check progress.
 */

const express = require('express');
const { runTask } = require('./runner');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const runningTasks = new Map();

app.post('/execute', (req, res) => {
  const task = req.body;

  if (!task.taskId) {
    return res.status(400).json({ error: 'taskId is required' });
  }
  if (!Array.isArray(task.profiles) || task.profiles.length < 1) {
    return res.status(400).json({ error: 'profiles must be a non-empty array of user IDs' });
  }
  if (!task.steps || !Array.isArray(task.steps)) {
    return res.status(400).json({ error: 'steps must be an array' });
  }

  if (runningTasks.has(task.taskId)) {
    const existing = runningTasks.get(task.taskId);
    if (existing.status === 'running') {
      return res.status(409).json({ error: `Task ${task.taskId} is already running` });
    }
  }

  const entry = {
    taskId: task.taskId,
    profiles: task.profiles,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    result: null,
    error: null,
  };
  runningTasks.set(task.taskId, entry);

  runTask(task)
    .then((result) => {
      entry.status = 'done';
      entry.completedAt = new Date().toISOString();
      entry.result = result;
    })
    .catch((err) => {
      entry.status = 'error';
      entry.completedAt = new Date().toISOString();
      entry.error = err.message;
      console.error(`Task ${task.taskId} failed:`, err);
    });

  res.status(202).json({
    taskId: task.taskId,
    status: 'running',
    message: 'Task started',
  });
});

app.get('/status/:taskId', (req, res) => {
  const entry = runningTasks.get(req.params.taskId);
  if (!entry) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(entry);
});

app.listen(PORT, () => {
  console.log(`FB Automation server running on http://localhost:${PORT}`);
  console.log(`POST /execute to fire a task, GET /status/:taskId to check progress`);
});
