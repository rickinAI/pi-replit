import { execFile } from "child_process";
import { getAccessToken } from "./gmail.js";
import path from "path";

const GWS_BIN = path.join(process.cwd(), "bin", "gws");
const TIMEOUT_MS = 15000;

export async function runGws(args: string[]): Promise<{ ok: boolean; data: any; raw: string }> {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, data: null, raw: "Google not connected — visit /api/gmail/auth to connect" };
  }

  return new Promise((resolve) => {
    const env = { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: token };

    execFile(GWS_BIN, args, { env, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const errMsg = stderr || err.message || "Unknown error";
        console.error(`[gws] Error running: gws ${args.join(" ")}`, errMsg);

        if (errMsg.includes("401") || errMsg.includes("Unauthorized") || errMsg.includes("invalid_credentials")) {
          resolve({ ok: false, data: null, raw: "Google authorization expired — visit /api/gmail/auth to reconnect" });
          return;
        }
        if (errMsg.includes("403") || errMsg.includes("Forbidden") || errMsg.includes("insufficient")) {
          resolve({ ok: false, data: null, raw: "Insufficient permissions — visit /api/gmail/auth to reconnect with required scopes" });
          return;
        }

        resolve({ ok: false, data: null, raw: `Error: ${errMsg.slice(0, 500)}` });
        return;
      }

      const output = stdout.trim();
      try {
        const data = JSON.parse(output);
        resolve({ ok: true, data, raw: output });
      } catch {
        resolve({ ok: true, data: null, raw: output });
      }
    });
  });
}

export async function driveList(query?: string, pageSize: number = 20): Promise<string> {
  const params: any = {
    pageSize,
    fields: "files(id,name,mimeType,modifiedTime,size,parents,webViewLink)",
    orderBy: "modifiedTime desc",
  };
  if (query) params.q = query;

  const args = ["drive", "files", "list", "--params", JSON.stringify(params)];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const files = result.data?.files;
  if (!files || files.length === 0) return query ? `No files found matching query.` : "No files in Drive.";

  const lines = files.map((f: any, i: number) => {
    const type = f.mimeType === "application/vnd.google-apps.folder" ? "📁" :
                 f.mimeType === "application/vnd.google-apps.spreadsheet" ? "📊" :
                 f.mimeType === "application/vnd.google-apps.document" ? "📄" :
                 f.mimeType === "application/vnd.google-apps.presentation" ? "📽️" :
                 "📎";
    const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    return `${i + 1}. ${type} ${f.name}\n   ID: ${f.id}\n   Modified: ${modified}${f.webViewLink ? `\n   Link: ${f.webViewLink}` : ""}`;
  });

  return `Drive files (${files.length}):\n\n${lines.join("\n\n")}`;
}

export async function driveGet(fileId: string): Promise<string> {
  const args = ["drive", "files", "get", "--params", JSON.stringify({ fileId, fields: "id,name,mimeType,modifiedTime,size,parents,webViewLink,description,owners,shared" })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const f = result.data;
  if (!f) return "File not found.";

  const lines = [
    `Name: ${f.name}`,
    `ID: ${f.id}`,
    `Type: ${f.mimeType}`,
    f.size ? `Size: ${(parseInt(f.size) / 1024).toFixed(1)} KB` : null,
    f.modifiedTime ? `Modified: ${new Date(f.modifiedTime).toLocaleString("en-US", { timeZone: "America/New_York" })}` : null,
    f.owners ? `Owner: ${f.owners.map((o: any) => o.displayName || o.emailAddress).join(", ")}` : null,
    f.shared !== undefined ? `Shared: ${f.shared}` : null,
    f.webViewLink ? `Link: ${f.webViewLink}` : null,
    f.description ? `Description: ${f.description}` : null,
    f.parents ? `Parent folder ID: ${f.parents.join(", ")}` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

export async function driveCreateFolder(name: string, parentId?: string): Promise<string> {
  const body: any = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) body.parents = [parentId];

  const args = ["drive", "files", "create", "--json", JSON.stringify(body), "--params", JSON.stringify({ fields: "id,name,webViewLink" })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const f = result.data;
  return `Created folder: "${f?.name || name}"\nID: ${f?.id || "unknown"}${f?.webViewLink ? `\nLink: ${f.webViewLink}` : ""}`;
}

export async function driveMove(fileId: string, newParentId: string): Promise<string> {
  const getResult = await runGws(["drive", "files", "get", "--params", JSON.stringify({ fileId, fields: "id,name,parents" })]);
  if (!getResult.ok) return getResult.raw;

  const currentParents = getResult.data?.parents?.join(",") || "";

  const args = ["drive", "files", "update", "--params", JSON.stringify({
    fileId,
    addParents: newParentId,
    removeParents: currentParents,
    fields: "id,name,parents",
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Moved "${result.data?.name || fileId}" to folder ${newParentId}`;
}

export async function driveRename(fileId: string, newName: string): Promise<string> {
  const args = ["drive", "files", "update", "--params", JSON.stringify({ fileId }), "--json", JSON.stringify({ name: newName })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Renamed to: "${result.data?.name || newName}"`;
}

export async function driveDelete(fileId: string): Promise<string> {
  const args = ["drive", "files", "update", "--params", JSON.stringify({ fileId }), "--json", JSON.stringify({ trashed: true })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Moved "${result.data?.name || fileId}" to trash.`;
}

export async function sheetsRead(spreadsheetId: string, range: string): Promise<string> {
  const args = ["sheets", "+read", "--spreadsheet", spreadsheetId, "--range", range];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  if (result.data?.values) {
    const rows = result.data.values;
    if (rows.length === 0) return "No data in the specified range.";
    const formatted = rows.map((row: any[], i: number) => `Row ${i + 1}: ${row.join(" | ")}`).join("\n");
    return `${range} (${rows.length} rows):\n\n${formatted}`;
  }

  return result.raw || "No data returned.";
}

export async function sheetsList(): Promise<string> {
  return driveList("mimeType='application/vnd.google-apps.spreadsheet'");
}

export async function sheetsAppend(spreadsheetId: string, values: string[][]): Promise<string> {
  const jsonValues = JSON.stringify(values);
  const args = ["sheets", "+append", "--spreadsheet", spreadsheetId, "--json-values", jsonValues];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Appended ${values.length} row(s) to spreadsheet.`;
}

export async function sheetsUpdate(spreadsheetId: string, range: string, values: string[][]): Promise<string> {
  const args = [
    "sheets", "spreadsheets", "values", "update",
    "--params", JSON.stringify({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
    }),
    "--json", JSON.stringify({ values }),
  ];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Updated ${range} with ${values.length} row(s).`;
}

export async function sheetsCreate(title: string): Promise<string> {
  const args = ["sheets", "spreadsheets", "create", "--json", JSON.stringify({ properties: { title } })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const s = result.data;
  return `Created spreadsheet: "${s?.properties?.title || title}"\nID: ${s?.spreadsheetId || "unknown"}\nURL: ${s?.spreadsheetUrl || ""}`;
}
