import { ReplitConnectors } from "@replit/connectors-sdk";

let connectors: ReplitConnectors | null = null;

function getConnectors(): ReplitConnectors {
  if (!connectors) {
    connectors = new ReplitConnectors();
  }
  return connectors;
}

async function ghFetch(endpoint: string, options: { method?: string; body?: any } = {}): Promise<any> {
  const c = getConnectors();
  const fetchOptions: any = { method: options.method || "GET" };
  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
    fetchOptions.headers = { "Content-Type": "application/json" };
  }
  const response = await c.proxy("github", endpoint, fetchOptions);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 300)}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export async function isConnected(): Promise<boolean> {
  try {
    await ghFetch("/user");
    return true;
  } catch {
    return false;
  }
}

export async function listRepos(perPage = 20): Promise<string> {
  const repos = await ghFetch(`/user/repos?per_page=${perPage}&sort=updated&type=all`);
  if (!Array.isArray(repos) || repos.length === 0) {
    return "No repositories found.";
  }
  const lines = repos.map((r: any, i: number) => {
    const vis = r.private ? "🔒 private" : "🌐 public";
    const lang = r.language || "—";
    const updated = r.updated_at ? new Date(r.updated_at).toLocaleDateString() : "—";
    return `${i + 1}. **${r.full_name}** (${vis})\n   Language: ${lang} | Updated: ${updated} | Stars: ${r.stargazers_count || 0}`;
  });
  return `Repositories (${repos.length}):\n\n${lines.join("\n\n")}`;
}

export async function listIssues(owner: string, repo: string, state = "open", perPage = 20): Promise<string> {
  const issues = await ghFetch(`/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}&sort=updated`);
  if (!Array.isArray(issues) || issues.length === 0) {
    return `No ${state} issues found in ${owner}/${repo}.`;
  }
  const filtered = issues.filter((i: any) => !i.pull_request);
  if (filtered.length === 0) {
    return `No ${state} issues found in ${owner}/${repo}.`;
  }
  const lines = filtered.map((issue: any) => {
    const labels = (issue.labels || []).map((l: any) => l.name).join(", ");
    const date = new Date(issue.created_at).toLocaleDateString();
    const assignee = issue.assignee?.login || "unassigned";
    return `#${issue.number}: ${issue.title}\n   State: ${issue.state} | Labels: ${labels || "none"} | Assignee: ${assignee} | Created: ${date} | Comments: ${issue.comments || 0}`;
  });
  return `Issues in ${owner}/${repo} (${state}, ${filtered.length}):\n\n${lines.join("\n\n")}`;
}

export async function readIssue(owner: string, repo: string, issueNumber: number): Promise<string> {
  const issue = await ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}`);
  const labels = (issue.labels || []).map((l: any) => l.name).join(", ");
  const assignees = (issue.assignees || []).map((a: any) => a.login).join(", ");

  let result = `# Issue #${issue.number}: ${issue.title}\n`;
  result += `State: ${issue.state} | Author: ${issue.user?.login}\n`;
  result += `Created: ${issue.created_at} | Updated: ${issue.updated_at}\n`;
  result += `Labels: ${labels || "none"} | Assignees: ${assignees || "none"}\n`;
  result += `Comments: ${issue.comments || 0}\n\n`;
  result += issue.body ? issue.body.slice(0, 5000) : "(no description)";

  if (issue.comments > 0) {
    try {
      const comments = await ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=10`);
      if (Array.isArray(comments) && comments.length > 0) {
        result += "\n\n---\nRecent comments:\n";
        for (const c of comments.slice(-5)) {
          result += `\n**${c.user?.login}** (${new Date(c.created_at).toLocaleDateString()}):\n${(c.body || "").slice(0, 1000)}\n`;
        }
      }
    } catch {}
  }

  return result;
}

export async function createIssue(owner: string, repo: string, title: string, body?: string, labels?: string[]): Promise<string> {
  const payload: any = { title };
  if (body) payload.body = body;
  if (labels && labels.length > 0) payload.labels = labels;

  const issue = await ghFetch(`/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: payload,
  });
  return `Issue created: #${issue.number} — ${issue.title}\nURL: ${issue.html_url}`;
}

export async function commentOnIssue(owner: string, repo: string, issueNumber: number, body: string): Promise<string> {
  const comment = await ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: { body },
  });
  return `Comment added to issue #${issueNumber}\nURL: ${comment.html_url}`;
}

export async function listPRs(owner: string, repo: string, state = "open", perPage = 20): Promise<string> {
  const prs = await ghFetch(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}&sort=updated`);
  if (!Array.isArray(prs) || prs.length === 0) {
    return `No ${state} pull requests found in ${owner}/${repo}.`;
  }
  const lines = prs.map((pr: any) => {
    const date = new Date(pr.created_at).toLocaleDateString();
    const draft = pr.draft ? " [DRAFT]" : "";
    return `#${pr.number}: ${pr.title}${draft}\n   State: ${pr.state} | Author: ${pr.user?.login} | Created: ${date} | ${pr.head?.ref} → ${pr.base?.ref}`;
  });
  return `Pull requests in ${owner}/${repo} (${state}, ${prs.length}):\n\n${lines.join("\n\n")}`;
}

export async function readPR(owner: string, repo: string, prNumber: number): Promise<string> {
  const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  const labels = (pr.labels || []).map((l: any) => l.name).join(", ");

  let result = `# PR #${pr.number}: ${pr.title}\n`;
  result += `State: ${pr.state}${pr.merged ? " (merged)" : ""}${pr.draft ? " [DRAFT]" : ""}\n`;
  result += `Author: ${pr.user?.login} | Branch: ${pr.head?.ref} → ${pr.base?.ref}\n`;
  result += `Created: ${pr.created_at} | Updated: ${pr.updated_at}\n`;
  result += `Labels: ${labels || "none"}\n`;
  result += `Commits: ${pr.commits} | Changed files: ${pr.changed_files} | +${pr.additions}/-${pr.deletions}\n`;
  result += `Mergeable: ${pr.mergeable ?? "unknown"}\n\n`;
  result += pr.body ? pr.body.slice(0, 5000) : "(no description)";

  return result;
}

export async function readFile(owner: string, repo: string, filePath: string, ref?: string): Promise<string> {
  let endpoint = `/repos/${owner}/${repo}/contents/${filePath}`;
  if (ref) endpoint += `?ref=${encodeURIComponent(ref)}`;

  const data = await ghFetch(endpoint);

  if (Array.isArray(data)) {
    const entries = data.map((item: any) => {
      const icon = item.type === "dir" ? "📁" : "📄";
      return `${icon} ${item.name}${item.type === "dir" ? "/" : ""} (${item.size || 0} bytes)`;
    });
    return `Directory: ${owner}/${repo}/${filePath}\n\n${entries.join("\n")}`;
  }

  if (data.encoding === "base64" && data.content) {
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const truncated = content.length > 8000 ? content.slice(0, 8000) + "\n\n[...truncated]" : content;
    return `File: ${owner}/${repo}/${filePath} (${data.size} bytes)\n\n${truncated}`;
  }

  return `File: ${owner}/${repo}/${filePath} — binary or unsupported encoding (${data.size} bytes)`;
}

export async function searchCode(query: string, owner?: string, repo?: string): Promise<string> {
  let q = query;
  if (owner && repo) q += `+repo:${owner}/${repo}`;
  else if (owner) q += `+user:${owner}`;

  const data = await ghFetch(`/search/code?q=${encodeURIComponent(q)}&per_page=10`);
  if (!data.items || data.items.length === 0) {
    return `No code results found for "${query}".`;
  }
  const lines = data.items.map((item: any, i: number) => {
    return `${i + 1}. ${item.repository?.full_name}/${item.path}\n   Score: ${item.score?.toFixed(2) || "—"}`;
  });
  return `Code search results for "${query}" (${data.total_count} total):\n\n${lines.join("\n\n")}`;
}

export async function searchIssues(query: string, owner?: string, repo?: string, state?: string): Promise<string> {
  let q = query;
  if (owner && repo) q += `+repo:${owner}/${repo}`;
  else if (owner) q += `+user:${owner}`;
  if (state) q += `+state:${state}`;
  q += "+type:issue";

  const data = await ghFetch(`/search/issues?q=${encodeURIComponent(q)}&per_page=15`);
  if (!data.items || data.items.length === 0) {
    return `No issues found for "${query}".`;
  }
  const lines = data.items.map((item: any, i: number) => {
    const repo = item.repository_url?.split("/").slice(-2).join("/") || "";
    return `${i + 1}. ${repo}#${item.number}: ${item.title}\n   State: ${item.state} | Updated: ${new Date(item.updated_at).toLocaleDateString()}`;
  });
  return `Issue search results for "${query}" (${data.total_count} total):\n\n${lines.join("\n\n")}`;
}
