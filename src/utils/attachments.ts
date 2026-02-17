import { z } from "zod";
import type { AttachmentInfo } from "./types";
export type { AttachmentInfo } from "./types";

/** Zod schema for attachment info, shared across subagent tool input schemas. */
export const attachmentSchema = z.object({
  url: z.string().describe("Direct URL to the attachment"),
  name: z.string().describe("Filename of the attachment"),
  contentType: z.string().describe("MIME type (e.g. image/png, application/pdf)"),
});

/**
 * Build a prompt with optional file attachments.
 * Returns a plain string when there are no attachments, or a message array
 * with text + image/file content parts when attachments are present.
 */
export function buildPromptWithAttachments(text: string, attachments?: AttachmentInfo[]) {
  if (!attachments || attachments.length === 0) return text;

  const parts: (
    | { type: "text"; text: string }
    | { type: "image"; image: URL; mediaType: string }
    | { type: "file"; data: URL; filename: string; mediaType: string }
  )[] = [];

  if (text) parts.push({ type: "text", text });

  for (const att of attachments) {
    if (att.contentType.startsWith("image/")) {
      parts.push({ type: "image", image: new URL(att.url), mediaType: att.contentType });
    } else {
      parts.push({
        type: "file",
        data: new URL(att.url),
        filename: att.name,
        mediaType: att.contentType,
      });
    }
  }

  return [{ role: "user" as const, content: parts }];
}
