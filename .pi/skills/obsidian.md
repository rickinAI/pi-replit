# Obsidian Vault Access

You have direct access to the user's Obsidian vault through the Obsidian Local REST API.

## Available Tools

### obsidian_list
Browse files and folders in the vault.
- `path` (optional): Directory path inside the vault, defaults to root
- Example: List all folders at the root, then drill into a specific folder

### obsidian_read
Read the full markdown content of a note.
- `path` (required): Path to the note, e.g. "Daily Notes/2025-01-15.md"

### obsidian_search
Full-text search across all notes. Returns matching notes with context snippets.
- `query` (required): Search text

### obsidian_create
Create a new note or overwrite an existing one.
- `path` (required): Path for the note, e.g. "Ideas/app-concept.md"
- `content` (required): Markdown content

### obsidian_append
Append content to the end of an existing note.
- `path` (required): Path to the note
- `content` (required): Markdown content to append

## Best Practices

- When the user asks about their notes/files/ideas, use obsidian_search or obsidian_list first
- When saving ideas or information, prefer obsidian_append to add to existing notes, or obsidian_create for new ones
- Use markdown formatting in created/appended content
- Note paths use forward slashes and typically end in .md
