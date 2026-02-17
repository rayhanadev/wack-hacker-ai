---
name: pages
description: Create, update, read, and write pages — properties and content.
criteria: Use when the user wants to create a new page, update page properties, read or edit page content, or retrieve specific property values.
tools: create_page, update_page, retrieve_page_property, read_page_content, write_page_content, append_page_content
---

<creating>
- Determine the parent first: is the page going into a database (entry/row) or under another page (subpage)?
- For database parents: always retrieve_database first to understand the property schema. Set properties matching the schema.
- For page parents: search_notion to find the parent page by name, then create_page with page_id parent.
- Title property: for database pages, use the title property name from the schema (often "Name" or "Title"). Format: `{ "Name": { "title": [{ "text": { "content": "..." } }] } }`.
- Only set properties the user explicitly asked for. Don't populate optional fields speculatively.
- Body content uses the `content` parameter — write it in **markdown**.
  - Supports: headings, bullet/numbered lists, to-dos, quotes, code blocks, dividers, paragraphs.
  - Example: `"# Overview\n\nThis page covers...\n\n- Point one\n- Point two"`

<property_formats>
Common property value formats for create/update:

- title: `{ "title": [{ "text": { "content": "text" } }] }`
- rich_text: `{ "rich_text": [{ "text": { "content": "text" } }] }`
- number: `{ "number": 42 }`
- select: `{ "select": { "name": "Option" } }`
- multi_select: `{ "multi_select": [{ "name": "Tag1" }, { "name": "Tag2" }] }`
- status: `{ "status": { "name": "In Progress" } }`
- date: `{ "date": { "start": "2024-01-15", "end": "2024-01-20" } }` (end is optional)
- checkbox: `{ "checkbox": true }`
- url: `{ "url": "https://..." }`
- email: `{ "email": "user@example.com" }`
- people: `{ "people": [{ "id": "user-uuid" }] }` (resolve via list_users)
- relation: `{ "relation": [{ "id": "page-uuid" }] }` (resolve via search_notion)
  </property_formats>
  </creating>

<content>
All page body content is markdown. No need to think about blocks or rich text — the tools handle conversion automatically.

- read_page_content: Returns the full page body as markdown.
- write_page_content: Replaces the entire page body with new markdown. Use when the user wants to rewrite or overhaul content.
- append_page_content: Adds markdown to the end of a page. Use when the user wants to add content without replacing what's already there.
- create_page also accepts a `content` parameter for initial markdown body.

Supported markdown:

- `# Heading 1`, `## Heading 2`, `### Heading 3`
- `- Bulleted item` and `1. Numbered item`
- `- [ ] To-do` and `- [x] Completed to-do`
- `> Blockquote`
- Code blocks with triple backticks and optional language
- `---` for dividers
- Plain paragraphs
  </content>

<updating>
- Update only the properties the user asked for. Don't touch other fields.
- To clear a property, set it to its empty value (e.g., `{ "select": null }`, `{ "rich_text": [] }`).
- Archive a page by setting `archived: true`. This is Notion's soft-delete.
- Icon and cover can be set: icon as `{ "emoji": "..." }` or `{ "external": { "url": "..." } }`, cover as `{ "external": { "url": "..." } }`.
- To update page body content, use write_page_content (full replace) or append_page_content (add to end).
</updating>

<property_retrieval>

- Use retrieve_page for a summary of all properties with inline values.
- Use retrieve_page_property for paginated properties (relations with many items, rollups, formulas). Pass the property_id from retrieve_page results.
- Large relation lists are paginated — use retrieve_page_property with pagination to get all related pages.
  </property_retrieval>
