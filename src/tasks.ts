import { getPool } from "./db.js";

interface Task {
  id: string;
  title: string;
  description?: string;
  dueDate?: string;
  priority: "low" | "medium" | "high";
  completed: boolean;
  createdAt: string;
  completedAt?: string;
  tags?: string[];
}

export async function init(): Promise<void> {
  const existing = await getPool().query(`SELECT count(*) FROM tasks`);
  if (parseInt(existing.rows[0].count) === 0) {
    try {
      const fs = await import("fs");
      const pathMod = await import("path");
      const legacyPath = pathMod.default.join(process.cwd(), "data", "tasks.json");
      if (fs.default.existsSync(legacyPath)) {
        const legacyTasks = JSON.parse(fs.default.readFileSync(legacyPath, "utf-8"));
        for (const t of legacyTasks) {
          await getPool().query(
            `INSERT INTO tasks (id, title, description, due_date, priority, completed, created_at, completed_at, tags)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
            [t.id, t.title, t.description || null, t.dueDate || null, t.priority || "medium", t.completed || false, t.createdAt, t.completedAt || null, JSON.stringify(t.tags || [])]
          );
        }
        console.log(`[tasks] Migrated ${legacyTasks.length} tasks from data/tasks.json to PostgreSQL`);
      }
    } catch (err) {
      console.error("[tasks] Task migration failed:", err);
    }
  }

  console.log("[tasks] initialized");
}

function generateId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function loadTasks(): Promise<Task[]> {
  const result = await getPool().query(`SELECT * FROM tasks ORDER BY created_at DESC`);
  return result.rows.map(rowToTask);
}

async function saveTask(task: Task): Promise<void> {
  await getPool().query(
    `INSERT INTO tasks (id, title, description, due_date, priority, completed, created_at, completed_at, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       due_date = EXCLUDED.due_date,
       priority = EXCLUDED.priority,
       completed = EXCLUDED.completed,
       completed_at = EXCLUDED.completed_at,
       tags = EXCLUDED.tags`,
    [task.id, task.title, task.description || null, task.dueDate || null, task.priority, task.completed, task.createdAt, task.completedAt || null, JSON.stringify(task.tags || [])]
  );
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description || undefined,
    dueDate: row.due_date || undefined,
    priority: row.priority as Task["priority"],
    completed: row.completed,
    createdAt: row.created_at,
    completedAt: row.completed_at || undefined,
    tags: Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags || "[]"),
  };
}

export async function addTask(title: string, options?: { description?: string; dueDate?: string; priority?: string; tags?: string[] }): Promise<string> {
  const task: Task = {
    id: generateId(),
    title,
    description: options?.description,
    dueDate: options?.dueDate,
    priority: (options?.priority as Task["priority"]) || "medium",
    completed: false,
    createdAt: new Date().toISOString(),
    tags: options?.tags,
  };
  await saveTask(task);
  return `Added task: "${title}"${task.dueDate ? ` (due: ${task.dueDate})` : ""}${task.priority !== "medium" ? ` [${task.priority} priority]` : ""}`;
}

export async function listTasks(filter?: { showCompleted?: boolean; tag?: string; priority?: string }): Promise<string> {
  const tasks = await loadTasks();
  let filtered = tasks;

  if (!filter?.showCompleted) {
    filtered = filtered.filter(t => !t.completed);
  }
  if (filter?.tag) {
    filtered = filtered.filter(t => t.tags?.includes(filter.tag!));
  }
  if (filter?.priority) {
    filtered = filtered.filter(t => t.priority === filter.priority);
  }

  if (filtered.length === 0) {
    return filter?.showCompleted ? "No tasks found." : "No open tasks. You're all caught up!";
  }

  filtered.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) return priorityOrder[a.priority] - priorityOrder[b.priority];
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });

  const lines = filtered.map((t, i) => {
    const status = t.completed ? "[x]" : "[ ]";
    const priority = t.priority === "high" ? " !!" : t.priority === "low" ? " ~" : "";
    const due = t.dueDate ? ` (due: ${t.dueDate})` : "";
    const tags = t.tags?.length ? ` [${t.tags.join(", ")}]` : "";
    return `${i + 1}. ${status} ${t.title}${priority}${due}${tags}\n   ID: ${t.id}${t.description ? `\n   ${t.description}` : ""}`;
  });

  const openCount = filtered.filter(t => !t.completed).length;
  const doneCount = filtered.filter(t => t.completed).length;
  let header = `Tasks (${openCount} open`;
  if (doneCount > 0) header += `, ${doneCount} completed`;
  header += "):";

  return `${header}\n\n${lines.join("\n\n")}`;
}

export async function completeTask(taskId: string): Promise<string> {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  if (task.completed) return `Task already completed: "${task.title}"`;
  task.completed = true;
  task.completedAt = new Date().toISOString();
  await saveTask(task);
  return `Completed task: "${task.title}"`;
}

export async function deleteTask(taskId: string): Promise<string> {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  await getPool().query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
  return `Deleted task: "${task.title}"`;
}

export async function updateTask(taskId: string, updates: { title?: string; description?: string; dueDate?: string; priority?: string; tags?: string[] }): Promise<string> {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  if (updates.title) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.dueDate !== undefined) task.dueDate = updates.dueDate;
  if (updates.priority) task.priority = updates.priority as Task["priority"];
  if (updates.tags) task.tags = updates.tags;
  await saveTask(task);
  return `Updated task: "${task.title}"`;
}
