/**
 * Express server exposing POST /execute endpoint for task execution.
 */

const express = require('express');
const { runTask } = require('./runner');

const app = express();
app.use(express.json());

const PORT = 3000;

/**
 * POST /execute
 *
 * Body: {
 *   taskId: string,
 *   browsers: number,
 *   steps: Array<Step>
 * }
 *
 * Returns: {
 *   taskId: string,
 *   results: Array<{ profileId, status, error? }>
 * }
 */
app.post('/execute', async (req, res) => {
  const task = req.body;

  // Basic validation
  if (!task.taskId) {
    return res.status(400).json({ error: 'taskId is required' });
  }
  if (!task.browsers || task.browsers < 1) {
    return res.status(400).json({ error: 'browsers must be >= 1' });
  }
  if (!task.steps || !Array.isArray(task.steps)) {
    return res.status(400).json({ error: 'steps must be an array' });
  }

  try {
    const result = await runTask(task);
    res.json(result);
  } catch (err) {
    console.error('Task execution failed:', err);
    res.status(500).json({
      taskId: task.taskId,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`FB Automation server running on http://localhost:${PORT}`);
  console.log(`POST /execute to run tasks`);
});
