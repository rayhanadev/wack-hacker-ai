/**
 * Bidirectional markdown <-> Notion blocks codec.
 *
 * Extracted from notion-fs/src/codec.ts. Pure functions, no Effect dependency.
 * Handles: paragraph, heading 1-3, bulleted/numbered list, to-do, quote, code, divider.
 * Rich text is chunked at 2000 chars to respect Notion API limits.
 */

import { marked, type Tokens } from "marked";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface BlockTreeNode {
  readonly block: { readonly type: string; readonly [key: string]: unknown };
  readonly children: ReadonlyArray<BlockTreeNode>;
}

type MarkdownBlockType =
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bulleted_list_item"
  | "numbered_list_item"
  | "to_do"
  | "quote"
  | "code"
  | "divider";

interface MarkdownBlock {
  type: MarkdownBlockType;
  text: string;
  checked: boolean;
  language: string;
}

// ---------------------------------------------------------------------------
// Safe object access helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null;

const getRecord = (value: unknown, key: string): JsonRecord | null => {
  if (!isRecord(value)) return null;
  const next = (value as JsonRecord)[key];
  return isRecord(next) ? (next as JsonRecord) : null;
};

const getArray = (value: unknown, key: string): ReadonlyArray<unknown> | undefined => {
  if (!isRecord(value)) return undefined;
  const next = (value as JsonRecord)[key];
  return Array.isArray(next) ? (next as ReadonlyArray<unknown>) : undefined;
};

const getString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const next = (value as JsonRecord)[key];
  return typeof next === "string" ? next : undefined;
};

const getBoolean = (value: unknown, key: string): boolean | undefined => {
  if (!isRecord(value)) return undefined;
  const next = (value as JsonRecord)[key];
  return typeof next === "boolean" ? next : undefined;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RICH_TEXT_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const createMarkdownBlock = (
  type: MarkdownBlockType,
  text = "",
  checked = false,
  language = "plain text",
): MarkdownBlock => ({ type, text, checked, language });

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_full, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_full, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));

const normalizeInlineText = (value: string): string =>
  decodeHtmlEntities(value)
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .trim();

const headingTypeFromLevel = (level: number): MarkdownBlockType => {
  if (level <= 1) return "heading_1";
  if (level === 2) return "heading_2";
  return "heading_3";
};

const inlineTokensToText = (tokens: ReadonlyArray<Tokens.Generic> | undefined): string => {
  if (!tokens || tokens.length === 0) return "";
  const parts: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "escape":
      case "codespan":
      case "html":
        parts.push(token.text);
        break;
      case "strong":
      case "em":
      case "del":
      case "link":
        parts.push(inlineTokensToText(token.tokens));
        break;
      case "image":
        parts.push(token.text);
        break;
      case "br":
        parts.push("\n");
        break;
      default:
        if ("text" in token && typeof token.text === "string") {
          parts.push(token.text);
        }
    }
  }
  return normalizeInlineText(parts.join(""));
};

const blockTokensToText = (tokens: ReadonlyArray<Tokens.Generic>): string => {
  const lines: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "heading":
      case "paragraph": {
        const next = inlineTokensToText(token.tokens) || normalizeInlineText(token.text);
        if (next.length > 0) lines.push(next);
        break;
      }
      case "text": {
        const next = inlineTokensToText(token.tokens) || normalizeInlineText(token.text);
        if (next.length > 0) lines.push(next);
        break;
      }
      case "code": {
        const next = normalizeInlineText(token.text);
        if (next.length > 0) lines.push(next);
        break;
      }
      case "list": {
        for (const item of token.items) {
          const next = blockTokensToText(item.tokens ?? []) || normalizeInlineText(item.text);
          if (next.length > 0) lines.push(next);
        }
        break;
      }
      case "blockquote": {
        const next = blockTokensToText(token.tokens ?? []);
        if (next.length > 0) lines.push(next);
        break;
      }
      default: {
        if ("text" in token && typeof token.text === "string") {
          const next = normalizeInlineText(token.text);
          if (next.length > 0) lines.push(next);
        }
      }
    }
  }
  return normalizeInlineText(lines.join("\n"));
};

// ---------------------------------------------------------------------------
// Markdown → Notion blocks
// ---------------------------------------------------------------------------

const parseMarkdownToBlocks = (markdown: string): ReadonlyArray<MarkdownBlock> => {
  const tokens = marked.lexer(markdown, { gfm: true, breaks: false });
  const blocks: MarkdownBlock[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "space":
        continue;
      case "heading": {
        const text = inlineTokensToText(token.tokens) || normalizeInlineText(token.text);
        if (text.length > 0) {
          blocks.push(createMarkdownBlock(headingTypeFromLevel(Number.parseInt(String(token.depth), 10)), text));
        }
        continue;
      }
      case "paragraph": {
        const text = inlineTokensToText(token.tokens) || normalizeInlineText(token.text);
        if (text.length > 0) blocks.push(createMarkdownBlock("paragraph", text));
        continue;
      }
      case "text": {
        const text = inlineTokensToText(token.tokens) || normalizeInlineText(token.text);
        if (text.length > 0) blocks.push(createMarkdownBlock("paragraph", text));
        continue;
      }
      case "list": {
        for (const item of token.items) {
          const itemText = blockTokensToText(item.tokens ?? []) || normalizeInlineText(item.text);
          if (itemText.length === 0) continue;
          if (item.task) {
            blocks.push(createMarkdownBlock("to_do", itemText, item.checked ?? false));
            continue;
          }
          blocks.push(createMarkdownBlock(token.ordered ? "numbered_list_item" : "bulleted_list_item", itemText));
        }
        continue;
      }
      case "blockquote": {
        const text = blockTokensToText(token.tokens ?? []);
        if (text.length > 0) blocks.push(createMarkdownBlock("quote", text));
        continue;
      }
      case "code": {
        const language = normalizeInlineText(token.lang ?? "") || "plain text";
        const codeText = token.text.replace(/\r\n/g, "\n").replace(/\n$/, "");
        blocks.push(createMarkdownBlock("code", codeText, false, language));
        continue;
      }
      case "hr": {
        blocks.push(createMarkdownBlock("divider"));
        continue;
      }
      default: {
        if ("text" in token && typeof token.text === "string") {
          const text = normalizeInlineText(token.text);
          if (text.length > 0) blocks.push(createMarkdownBlock("paragraph", text));
        }
      }
    }
  }
  return blocks;
};

const toRichTextItems = (text: string): JsonRecord[] => {
  const source = text.length > 0 ? text : " ";
  const chunks: JsonRecord[] = [];
  let index = 0;
  while (index < source.length) {
    const chunk = source.slice(index, index + MAX_RICH_TEXT_CHARS);
    chunks.push({ type: "text", text: { content: chunk } });
    index += MAX_RICH_TEXT_CHARS;
  }
  return chunks;
};

const toNotionBlocks = (blocks: ReadonlyArray<MarkdownBlock>): ReadonlyArray<JsonRecord> =>
  blocks.map((block): JsonRecord => {
    switch (block.type) {
      case "heading_1":
      case "heading_2":
      case "heading_3":
      case "paragraph":
      case "bulleted_list_item":
      case "numbered_list_item":
      case "quote":
        return { object: "block", type: block.type, [block.type]: { rich_text: toRichTextItems(block.text) } };
      case "to_do":
        return { object: "block", type: "to_do", to_do: { checked: block.checked, rich_text: toRichTextItems(block.text) } };
      case "code":
        return { object: "block", type: "code", code: { language: block.language, rich_text: toRichTextItems(block.text) } };
      case "divider":
        return { object: "block", type: "divider", divider: {} };
    }
  });

// ---------------------------------------------------------------------------
// Notion blocks → Markdown
// ---------------------------------------------------------------------------

const richTextToString = (value: unknown): string => {
  const richText = getArray(value, "rich_text");
  if (!richText) return "";
  return richText
    .map((item) => {
      if (!isRecord(item)) return "";
      const plainText = getString(item, "plain_text");
      if (plainText) return plainText;
      const textRecord = getRecord(item, "text");
      return textRecord ? (getString(textRecord, "content") ?? "") : "";
    })
    .join("")
    .trimEnd();
};

const extractTextFromNotionBlock = (block: { readonly type: string }): string => {
  const payload = getRecord(block, block.type);
  if (!payload) return "";
  return richTextToString(payload);
};

const fromNotionBlocks = (blocks: ReadonlyArray<JsonRecord>): ReadonlyArray<MarkdownBlock> =>
  blocks.map((block) => {
    const blockType = getString(block, "type") ?? "paragraph";
    switch (blockType) {
      case "heading_1":
      case "heading_2":
      case "heading_3":
      case "paragraph":
      case "bulleted_list_item":
      case "numbered_list_item":
      case "quote": {
        const payload = getRecord(block, blockType);
        return createMarkdownBlock(blockType, payload ? richTextToString(payload) : "");
      }
      case "to_do": {
        const payload = getRecord(block, "to_do");
        return createMarkdownBlock(
          "to_do",
          payload ? richTextToString(payload) : "",
          payload ? (getBoolean(payload, "checked") ?? false) : false,
        );
      }
      case "code": {
        const payload = getRecord(block, "code");
        return createMarkdownBlock(
          "code",
          payload ? richTextToString(payload) : "",
          false,
          payload ? (getString(payload, "language") ?? "plain text") : "plain text",
        );
      }
      case "divider":
        return createMarkdownBlock("divider");
      default: {
        const payload = getRecord(block, blockType);
        const fallbackText = payload ? richTextToString(payload) : `[unsupported:${blockType}]`;
        return createMarkdownBlock("paragraph", fallbackText.length > 0 ? fallbackText : `[${blockType}]`);
      }
    }
  });

const renderBlocksToMarkdown = (blocks: ReadonlyArray<MarkdownBlock>): string => {
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading_1":
        lines.push(`# ${block.text}`.trimEnd());
        break;
      case "heading_2":
        lines.push(`## ${block.text}`.trimEnd());
        break;
      case "heading_3":
        lines.push(`### ${block.text}`.trimEnd());
        break;
      case "bulleted_list_item":
        lines.push(`- ${block.text}`.trimEnd());
        break;
      case "numbered_list_item":
        lines.push(`1. ${block.text}`.trimEnd());
        break;
      case "to_do":
        lines.push(`- [${block.checked ? "x" : " "}] ${block.text}`.trimEnd());
        break;
      case "quote":
        lines.push(`> ${block.text}`.trimEnd());
        break;
      case "code":
        lines.push(`\`\`\`${block.language ?? ""}`.trimEnd());
        if (block.text.length > 0) lines.push(block.text);
        lines.push("```");
        break;
      case "divider":
        lines.push("---");
        break;
      default:
        lines.push(block.text);
    }
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Block tree → Markdown (handles nested children)
// ---------------------------------------------------------------------------

const renderBlockTreeNode = (node: BlockTreeNode, depth: number): string[] => {
  const block = node.block;
  const lines: string[] = [];

  switch (block.type) {
    case "heading_1":
      lines.push(`# ${extractTextFromNotionBlock(block)}`);
      break;
    case "heading_2":
      lines.push(`## ${extractTextFromNotionBlock(block)}`);
      break;
    case "heading_3":
      lines.push(`### ${extractTextFromNotionBlock(block)}`);
      break;
    case "bulleted_list_item":
      lines.push(`${"  ".repeat(depth)}- ${extractTextFromNotionBlock(block)}`.trimEnd());
      break;
    case "numbered_list_item":
      lines.push(`${"  ".repeat(depth)}1. ${extractTextFromNotionBlock(block)}`.trimEnd());
      break;
    case "to_do": {
      const payload = getRecord(block, "to_do");
      const checked = payload ? Boolean(payload.checked) : false;
      lines.push(`${"  ".repeat(depth)}- [${checked ? "x" : " "}] ${extractTextFromNotionBlock(block)}`.trimEnd());
      break;
    }
    case "quote":
      lines.push(`> ${extractTextFromNotionBlock(block)}`);
      break;
    case "code": {
      const payload = getRecord(block, "code");
      const language = payload ? getString(payload, "language") : undefined;
      lines.push(`\`\`\`${language ?? ""}`.trimEnd());
      lines.push(extractTextFromNotionBlock(block));
      lines.push("```");
      break;
    }
    case "divider":
      lines.push("---");
      break;
    case "paragraph":
      lines.push(extractTextFromNotionBlock(block));
      break;
    default: {
      const text = extractTextFromNotionBlock(block);
      lines.push(text || `[${block.type}]`);
    }
  }

  for (const child of node.children) {
    const childLines = renderBlockTreeNode(
      child,
      block.type === "bulleted_list_item" ||
        block.type === "numbered_list_item" ||
        block.type === "to_do"
        ? depth + 1
        : depth,
    );
    if (childLines.length > 0 && lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(...childLines);
  }

  return lines;
};

const renderBlockTreeToMarkdown = (blockTree: ReadonlyArray<BlockTreeNode>): string => {
  const lines: string[] = [];
  for (const node of blockTree) {
    const blockLines = renderBlockTreeNode(node, 0);
    lines.push(...blockLines);
    if (blockLines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Convert markdown text to Notion API block payloads. */
export function markdownToBlocks(markdown: string): any[] {
  return toNotionBlocks(parseMarkdownToBlocks(markdown)) as any[];
}

/** Convert flat Notion API block payloads to markdown text. */
export function blocksToMarkdown(blocks: any[]): string {
  return renderBlocksToMarkdown(fromNotionBlocks(blocks));
}

/** Convert a recursive Notion block tree (blocks with children) to markdown. */
export function blockTreeToMarkdown(tree: ReadonlyArray<{ block: any; children: any[] }>): string {
  return renderBlockTreeToMarkdown(tree);
}
