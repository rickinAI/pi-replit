import { execFile } from "child_process";
import { getAccessToken } from "./gmail.js";
import path from "path";

const GWS_BIN = path.join(process.cwd(), "bin", "gws");
const TIMEOUT_MS = 15000;

function parseHexColor(hex: string): { red: number; green: number; blue: number } {
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

export async function runGws(args: string[]): Promise<{ ok: boolean; data: any; raw: string }> {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, data: null, raw: "Google not connected — visit /api/gmail/auth to connect" };
  }

  return new Promise((resolve) => {
    const env = { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: token };

    execFile(GWS_BIN, args, { env, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const errMsg = [stderr, stdout, err.message].filter(Boolean).join("\n").trim() || "Unknown error";
        console.error(`[gws] Error running: gws ${args.join(" ")}`, errMsg);

        if (errMsg.includes("401") || errMsg.includes("Unauthorized") || errMsg.includes("invalid_credentials")) {
          resolve({ ok: false, data: null, raw: "Google authorization expired — visit /api/gmail/auth to reconnect" });
          return;
        }
        if (errMsg.includes("403") || errMsg.includes("Forbidden") || errMsg.includes("insufficient")) {
          resolve({ ok: false, data: null, raw: "Insufficient permissions — visit /api/gmail/auth to reconnect with required scopes" });
          return;
        }

        resolve({ ok: false, data: null, raw: `Error: ${errMsg.slice(0, 1000)}` });
        return;
      }

      const output = stdout.trim();
      try {
        const data = JSON.parse(output);
        resolve({ ok: true, data, raw: output });
      } catch {
        resolve({ ok: false, data: null, raw: output });
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

export async function sheetsAddSheet(spreadsheetId: string, title: string): Promise<string> {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{ addSheet: { properties: { title } } }],
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const reply = result.data?.replies?.[0]?.addSheet;
  const sheetId = reply?.properties?.sheetId ?? "unknown";
  return `Added sheet "${title}" (sheetId: ${sheetId}) to spreadsheet ${spreadsheetId}.`;
}

export async function sheetsDeleteSheet(spreadsheetId: string, sheetId: number): Promise<string> {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{ deleteSheet: { sheetId } }],
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Deleted sheet ${sheetId} from spreadsheet ${spreadsheetId}.`;
}

export async function sheetsClear(spreadsheetId: string, range: string): Promise<string> {
  const args = ["sheets", "spreadsheets", "values", "clear", "--params", JSON.stringify({ spreadsheetId, range }), "--json", JSON.stringify({})];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Cleared range ${range} in spreadsheet ${spreadsheetId}.`;
}

export async function sheetsFormatCells(spreadsheetId: string, sheetId: number, startRow: number, endRow: number, startCol: number, endCol: number, bold?: boolean, bgColor?: { red?: number; green?: number; blue?: number }, textColor?: { red?: number; green?: number; blue?: number }, fontSize?: number): Promise<string> {
  const cellFormat: any = {};
  const fields: string[] = [];

  if (bold !== undefined) {
    cellFormat.textFormat = { ...cellFormat.textFormat, bold };
    fields.push("userEnteredFormat.textFormat.bold");
  }
  if (fontSize !== undefined) {
    cellFormat.textFormat = { ...cellFormat.textFormat, fontSize };
    fields.push("userEnteredFormat.textFormat.fontSize");
  }
  if (bgColor) {
    cellFormat.backgroundColor = bgColor;
    fields.push("userEnteredFormat.backgroundColor");
  }
  if (textColor) {
    cellFormat.textFormat = { ...cellFormat.textFormat, foregroundColor: textColor };
    fields.push("userEnteredFormat.textFormat.foregroundColor");
  }

  if (fields.length === 0) return "Error: At least one formatting option (bold, fontSize, bgColor, textColor) must be specified.";

  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{
      repeatCell: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        cell: { userEnteredFormat: cellFormat },
        fields: fields.join(","),
      },
    }],
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Formatted cells [${startRow}:${endRow}, ${startCol}:${endCol}] in sheet ${sheetId}.`;
}

export async function sheetsAutoResize(spreadsheetId: string, sheetId: number, startCol?: number, endCol?: number): Promise<string> {
  const dimension: any = { sheetId, dimension: "COLUMNS" };
  if (startCol !== undefined) dimension.startIndex = startCol;
  if (endCol !== undefined) dimension.endIndex = endCol;

  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{ autoResizeDimensions: { dimensions: dimension } }],
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Auto-resized columns in sheet ${sheetId}.`;
}

export async function sheetsMergeCells(spreadsheetId: string, sheetId: number, startRow: number, endRow: number, startCol: number, endCol: number): Promise<string> {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{
      mergeCells: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        mergeType: "MERGE_ALL",
      },
    }],
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Merged cells [${startRow}:${endRow}, ${startCol}:${endCol}] in sheet ${sheetId}.`;
}

export async function sheetsBatchUpdate(spreadsheetId: string, requests: any[]): Promise<string> {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const replyCount = result.data?.replies?.length ?? 0;
  return `Batch update completed: ${requests.length} request(s) sent, ${replyCount} reply(ies) received.\n\n${result.raw}`;
}

export async function sheetsSort(spreadsheetId: string, sheetId: number, sortCol: number, ascending?: boolean): Promise<string> {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{
      sortRange: {
        range: { sheetId },
        sortSpecs: [{ dimensionIndex: sortCol, sortOrder: ascending === false ? "DESCENDING" : "ASCENDING" }],
      },
    }],
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Sorted sheet ${sheetId} by column ${sortCol} (${ascending === false ? "descending" : "ascending"}).`;
}

export async function docsList(): Promise<string> {
  return driveList("mimeType='application/vnd.google-apps.document'");
}

export async function docsGet(documentId: string): Promise<string> {
  const args = ["docs", "documents", "get", "--params", JSON.stringify({ documentId })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const doc = result.data;
  if (!doc) return "Document not found.";

  const title = doc.title || "Untitled";
  const docId = doc.documentId || documentId;

  const textParts: string[] = [];
  if (doc.body?.content) {
    for (const element of doc.body.content) {
      if (element.paragraph?.elements) {
        for (const el of element.paragraph.elements) {
          if (el.textRun?.content) textParts.push(el.textRun.content);
        }
      }
      if (element.table) {
        textParts.push("[Table]\n");
      }
    }
  }
  const textContent = textParts.join("");

  const lines = [
    `Title: ${title}`,
    `ID: ${docId}`,
    ``,
    `--- Content ---`,
    textContent.trim() || "(empty document)",
  ];

  return lines.join("\n");
}

export async function docsCreate(title: string): Promise<string> {
  const args = ["docs", "documents", "create", "--json", JSON.stringify({ title })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const doc = result.data;
  return `Created document: "${doc?.title || title}"\nID: ${doc?.documentId || "unknown"}`;
}

export async function docsAppend(documentId: string, text: string): Promise<string> {
  const args = ["docs", "+write", "--document", documentId, "--text", text];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Appended text to document ${documentId}.`;
}

export async function docsInsertText(documentId: string, text: string, index?: number): Promise<string> {
  const requests: any[] = [];
  if (index !== undefined) {
    requests.push({ insertText: { location: { index }, text } });
  } else {
    requests.push({ insertText: { endOfSegmentLocation: {}, text } });
  }
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted text into document ${documentId}${index !== undefined ? ` at index ${index}` : " at end"}.`;
}

export async function docsDeleteContent(documentId: string, startIndex: number, endIndex: number): Promise<string> {
  const requests = [{ deleteContentRange: { range: { startIndex, endIndex } } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Deleted content from index ${startIndex} to ${endIndex} in document ${documentId}.`;
}

export async function docsInsertTable(documentId: string, rows: number, cols: number): Promise<string> {
  const requests = [{ insertTable: { rows, columns: cols, endOfSegmentLocation: {} } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted ${rows}×${cols} table into document ${documentId}.`;
}

export async function docsFormatText(documentId: string, startIndex: number, endIndex: number, bold?: boolean, italic?: boolean, fontSize?: number, foregroundColor?: string): Promise<string> {
  const textStyle: any = {};
  const fields: string[] = [];
  if (bold !== undefined) { textStyle.bold = bold; fields.push("bold"); }
  if (italic !== undefined) { textStyle.italic = italic; fields.push("italic"); }
  if (fontSize !== undefined) { textStyle.fontSize = { magnitude: fontSize, unit: "PT" }; fields.push("fontSize"); }
  if (foregroundColor) {
    textStyle.foregroundColor = { color: { rgbColor: parseHexColor(foregroundColor) } };
    fields.push("foregroundColor");
  }
  if (fields.length === 0) return "Error: At least one formatting option (bold, italic, fontSize, foregroundColor) must be specified.";
  const requests = [{ updateTextStyle: { range: { startIndex, endIndex }, textStyle, fields: fields.join(",") } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Formatted text (index ${startIndex}–${endIndex}) in document ${documentId}.`;
}

export async function docsInsertImage(documentId: string, imageUri: string, index?: number): Promise<string> {
  const request: any = { insertInlineImage: { uri: imageUri } };
  if (index !== undefined) {
    request.insertInlineImage.location = { index };
  } else {
    request.insertInlineImage.endOfSegmentLocation = {};
  }
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests: [request] })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted image into document ${documentId}.`;
}

export async function docsReplaceText(documentId: string, findText: string, replaceText: string): Promise<string> {
  const requests = [{ replaceAllText: { containsText: { text: findText, matchCase: true }, replaceText } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const count = result.data?.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
  return `Replaced ${count} occurrence(s) of "${findText}" with "${replaceText}" in document ${documentId}.`;
}

export async function docsInsertHeading(documentId: string, text: string, level: number): Promise<string> {
  const headingStyle = `HEADING_${Math.min(Math.max(level, 1), 6)}`;

  const getArgs = ["docs", "documents", "get", "--params", JSON.stringify({ documentId })];
  const getResult = await runGws(getArgs);
  if (!getResult.ok) return getResult.raw;

  const body = getResult.data?.body?.content;
  const endIndex = body && body.length > 0 ? (body[body.length - 1]?.endIndex || 1) - 1 : 1;
  const insertAt = Math.max(endIndex, 1);

  const requests = [
    { insertText: { location: { index: insertAt }, text: text + "\n" } },
    { updateParagraphStyle: { range: { startIndex: insertAt, endIndex: insertAt + text.length + 1 }, paragraphStyle: { namedStyleType: headingStyle }, fields: "namedStyleType" } },
  ];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted heading (H${level}) "${text}" into document ${documentId}.`;
}

export async function docsBatchUpdate(documentId: string, requests: any[]): Promise<string> {
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Batch update applied ${requests.length} request(s) to document ${documentId}.\n${JSON.stringify(result.data?.replies || [], null, 2)}`;
}

export async function slidesList(): Promise<string> {
  return driveList("mimeType='application/vnd.google-apps.presentation'");
}

export async function slidesGet(presentationId: string): Promise<string> {
  const args = ["slides", "presentations", "get", "--params", JSON.stringify({ presentationId })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const pres = result.data;
  if (!pres) return "Presentation not found.";

  const title = pres.title || "Untitled";
  const presId = pres.presentationId || presentationId;
  const slideCount = pres.slides?.length || 0;

  const lines = [
    `Title: ${title}`,
    `ID: ${presId}`,
    `Slides: ${slideCount}`,
    `Page size: ${pres.pageSize?.width?.magnitude || "?"}×${pres.pageSize?.height?.magnitude || "?"} ${pres.pageSize?.width?.unit || ""}`,
  ];

  if (pres.slides) {
    lines.push("", "--- Slides ---");
    for (let i = 0; i < pres.slides.length; i++) {
      const slide = pres.slides[i];
      let slideText = "";
      if (slide.pageElements) {
        for (const el of slide.pageElements) {
          if (el.shape?.text?.textElements) {
            for (const te of el.shape.text.textElements) {
              if (te.textRun?.content) slideText += te.textRun.content;
            }
          }
        }
      }
      lines.push(`\nSlide ${i + 1} (${slide.objectId}):`);
      lines.push(slideText.trim() || "(no text)");
    }
  }

  return lines.join("\n");
}

export async function slidesCreate(title: string): Promise<string> {
  const args = ["slides", "presentations", "create", "--json", JSON.stringify({ title })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const pres = result.data;
  return `Created presentation: "${pres?.title || title}"\nID: ${pres?.presentationId || "unknown"}`;
}

export async function slidesAppend(presentationId: string, title: string, body: string): Promise<string> {
  const slideId = `slide_${Date.now()}`;

  const createArgs = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({
    requests: [
      {
        createSlide: {
          objectId: slideId,
          slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
        },
      },
    ],
  })];
  const createResult = await runGws(createArgs);
  if (!createResult.ok) return createResult.raw;

  const pageResult = await runGws(["slides", "presentations", "pages", "get", "--params", JSON.stringify({ presentationId, pageObjectId: slideId })]);
  if (!pageResult.ok) return pageResult.raw;

  const page = pageResult.data;
  let titleId = "";
  let bodyId = "";
  if (page?.pageElements) {
    for (const el of page.pageElements) {
      const phType = el.shape?.placeholder?.type;
      if (phType === "TITLE" || phType === "CENTERED_TITLE") titleId = el.objectId;
      else if (phType === "BODY" || phType === "SUBTITLE") bodyId = el.objectId;
    }
  }

  const textRequests: any[] = [];
  if (titleId && title) {
    textRequests.push({ insertText: { objectId: titleId, text: title, insertionIndex: 0 } });
  }
  if (bodyId && body) {
    textRequests.push({ insertText: { objectId: bodyId, text: body, insertionIndex: 0 } });
  }

  if (textRequests.length > 0) {
    const textArgs = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests: textRequests })];
    const textResult = await runGws(textArgs);
    if (!textResult.ok) return `Slide created but text insertion failed: ${textResult.raw}`;
  }

  return `Added slide "${title}" to presentation ${presentationId}.`;
}

export async function slidesInsertTable(presentationId: string, slideObjectId: string, rows: number, cols: number, data?: string[][]): Promise<string> {
  const tableId = `table_${Date.now()}`;
  const requests: any[] = [
    {
      createTable: {
        objectId: tableId,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: 7200000, unit: "EMU" },
            height: { magnitude: rows * 400000, unit: "EMU" },
          },
          transform: {
            scaleX: 1, scaleY: 1, translateX: 400000, translateY: 1500000, unit: "EMU",
          },
        },
        rows,
        columns: cols,
      },
    },
  ];

  if (data) {
    for (let r = 0; r < Math.min(data.length, rows); r++) {
      for (let c = 0; c < Math.min(data[r].length, cols); c++) {
        if (data[r][c]) {
          requests.push({
            insertText: {
              objectId: tableId,
              cellLocation: { rowIndex: r, columnIndex: c },
              text: data[r][c],
              insertionIndex: 0,
            },
          });
        }
      }
    }
  }

  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Inserted ${rows}×${cols} table on slide ${slideObjectId}.`;
}

export async function slidesInsertImage(presentationId: string, slideObjectId: string, imageUrl: string, width?: number, height?: number): Promise<string> {
  const requests = [
    {
      createImage: {
        url: imageUrl,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: width || 3000000, unit: "EMU" },
            height: { magnitude: height || 3000000, unit: "EMU" },
          },
          transform: {
            scaleX: 1, scaleY: 1, translateX: 2000000, translateY: 1500000, unit: "EMU",
          },
        },
      },
    },
  ];

  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Inserted image on slide ${slideObjectId}.`;
}

export async function slidesInsertShape(presentationId: string, slideObjectId: string, shapeType: string, text: string, left: number, top: number, width: number, height: number): Promise<string> {
  const shapeId = `shape_${Date.now()}`;
  const requests: any[] = [
    {
      createShape: {
        objectId: shapeId,
        shapeType,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: width, unit: "EMU" },
            height: { magnitude: height, unit: "EMU" },
          },
          transform: {
            scaleX: 1, scaleY: 1, translateX: left, translateY: top, unit: "EMU",
          },
        },
      },
    },
  ];

  if (text) {
    requests.push({
      insertText: {
        objectId: shapeId,
        text,
        insertionIndex: 0,
      },
    });
  }

  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Inserted ${shapeType} shape on slide ${slideObjectId}. Shape ID: ${shapeId}`;
}

export async function slidesFormatText(presentationId: string, objectId: string, startIndex: number, endIndex: number, bold?: boolean, italic?: boolean, fontSize?: number, color?: string): Promise<string> {
  const style: any = {};
  const fields: string[] = [];

  if (bold !== undefined) { style.bold = bold; fields.push("bold"); }
  if (italic !== undefined) { style.italic = italic; fields.push("italic"); }
  if (fontSize !== undefined) { style.fontSize = { magnitude: fontSize, unit: "PT" }; fields.push("fontSize"); }
  if (color) {
    style.foregroundColor = { opaqueColor: { rgbColor: parseHexColor(color) } };
    fields.push("foregroundColor");
  }

  if (fields.length === 0) return "Error: At least one formatting option (bold, italic, fontSize, color) must be specified.";

  const requests = [
    {
      updateTextStyle: {
        objectId,
        textRange: { type: "FIXED_RANGE", startIndex, endIndex },
        style,
        fields: fields.join(","),
      },
    },
  ];

  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Formatted text in object ${objectId} (chars ${startIndex}-${endIndex}).`;
}

export async function slidesDeleteSlide(presentationId: string, slideObjectId: string): Promise<string> {
  const requests = [{ deleteObject: { objectId: slideObjectId } }];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Deleted slide ${slideObjectId} from presentation ${presentationId}.`;
}

export async function slidesDuplicateSlide(presentationId: string, slideObjectId: string): Promise<string> {
  const requests = [{ duplicateObject: { objectId: slideObjectId } }];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const newId = result.data?.replies?.[0]?.duplicateObject?.objectId || "unknown";
  return `Duplicated slide ${slideObjectId}. New slide ID: ${newId}`;
}

export async function slidesReplaceText(presentationId: string, findText: string, replaceText: string): Promise<string> {
  const requests = [
    {
      replaceAllText: {
        containsText: { text: findText, matchCase: true },
        replaceText,
      },
    },
  ];

  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  const count = result.data?.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
  return `Replaced ${count} occurrence(s) of "${findText}" with "${replaceText}".`;
}

export async function slidesBatchUpdate(presentationId: string, requests: any[]): Promise<string> {
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;

  return `Batch update completed (${requests.length} request(s)). Response: ${JSON.stringify(result.data?.replies || []).slice(0, 2000)}`;
}
