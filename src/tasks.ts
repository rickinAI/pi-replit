import fs from "fs";
import path from "path";

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

let tasksFilePath = "";

export function init(root: string) {
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  tasksFilePath = path.join(dataDir, "tasks.json");
}

function loadTasks(): Task[] {
  if (!fs.existsSync(tasksFilePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(tasksFilePath, "utf-8"));
  } catch {
    return [];
  }
}

function saveTasks(tasks: Task[]) {
  fs.writeFileSync(tasksFilePath, JSON.stringify(tasks, null, 2));
}

function generateId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function addTask(title: string, options?: { description?: string; dueDate?: string; priority?: string; tags?: string[] }): string {
  const tasks = loadTasks();
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
  tasks.push(task);
  saveTasks(tasks);
  return `Added task: "${title}"${task.dueDate ? ` (due: ${task.dueDate})` : ""}${task.priority !== "medium" ? ` [${task.priority} priority]` : ""}`;
}

export function listTasks(filter?: { showCompleted?: boolean; tag?: string; priority?: string }): string {
  const tasks = loadTasks();
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

export function completeTask(taskId: string): string {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === taskId);
  if (!task) return `Task not found: ${taskId}`;
  if (task.completed) return `Task already completed: "${task.title}"`;
  task.completed = true;
  task.completedAt = new Date().toISOString();
  saveTasks(tasks);
  return `Completed task: "${task.title}"`;
}

export function deleteTask(taskId: string): string {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return `Task not found: ${taskId}`;
  const removed = tasks.splice(idx, 1)[0];
  saveTasks(tasks);
  return `Deleted task: "${removed.title}"`;
}

export function updateTask(taskId: string, updates: { title?: string; description?: string; dueDate?: string; priority?: string; tags?: string[] }): string {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === taskId);
  if (!task) return `Task not found: ${taskId}`;
  if (updates.title) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.dueDate !== undefined) task.dueDate = updates.dueDate;
  if (updates.priority) task.priority = updates.priority as Task["priority"];
  if (updates.tags) task.tags = updates.tags;
  saveTasks(tasks);
  return `Updated task: "${task.title}"`;
}
