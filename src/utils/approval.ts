import type { Tool } from "ai";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
} from "discord.js";
import { z } from "zod";
import type { ApprovalContext, ApprovalResult } from "./types";
export type { ApprovalContext, ApprovalResult } from "./types";

// ---------------------------------------------------------------------------
// requestApproval — standalone, reusable anywhere
// ---------------------------------------------------------------------------

/** Send an Approve / Deny embed with buttons and wait for a response. */
export async function requestApproval(
  ctx: ApprovalContext,
  embed: EmbedBuilder,
): Promise<ApprovalResult> {
  const timeout = ctx.timeout ?? 60_000;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("approval:approve")
      .setLabel("Approve")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("approval:deny")
      .setLabel("Deny")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );

  const prompt = await ctx.channel.send({ embeds: [embed], components: [row] });

  const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    row.components.map((b) => ButtonBuilder.from(b.toJSON()).setDisabled(true)),
  );

  try {
    const interaction = await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i: ButtonInteraction) => {
        if (ctx.userId && i.user.id !== ctx.userId) {
          void i.reply({
            content: "You are not authorized to respond.",
            flags: MessageFlags.Ephemeral,
          });
          return false;
        }
        return true;
      },
      time: timeout,
    });

    const approved = interaction.customId === "approval:approve";
    const resultEmbed = EmbedBuilder.from(embed.toJSON()).setColor(approved ? 0x57f287 : 0xed4245);
    await interaction.update({ embeds: [resultEmbed], components: [disabledRow] });

    return { approved, userId: interaction.user.id };
  } catch {
    const timedOutEmbed = EmbedBuilder.from(embed.toJSON()).setColor(0x95a5a6);
    await prompt.edit({ embeds: [timedOutEmbed], components: [disabledRow] });
    return { approved: false };
  }
}

// ---------------------------------------------------------------------------
// withApproval — higher-order tool wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap an AI SDK tool so its `execute` requires Discord button approval first.
 *
 * Adds a `reason` field to the tool's input schema that the AI must fill in.
 * Shows an embed:
 *
 *   I want to run the following command.
 *   Reason: reason
 *   command description
 *
 * If denied (or timed out), the tool returns `{ denied: true, reason }` without
 * calling the original execute. The ToolLoopAgent loop continues normally.
 */
export function withApproval<T extends Tool>(
  baseTool: T,
  ctx: ApprovalContext,
  formatCommand: (input: Record<string, unknown>) => string,
): T {
  const extendedSchema = (baseTool.inputSchema as z.ZodObject<any>).extend({
    reason: z.string().describe("Brief explanation of why this destructive action is needed"),
  });

  return {
    ...baseTool,
    inputSchema: extendedSchema,
    execute: async (args: Record<string, unknown>, execCtx: unknown) => {
      const { reason, ...originalArgs } = args;
      const command = formatCommand(originalArgs);

      const embed = new EmbedBuilder()
        .setDescription(
          `I want to run the following command.\n\n**Reason:** *${String(reason)}*\n\n${command}`,
        )
        .setColor(0xfee75c);

      const result = await requestApproval(ctx, embed);

      if (!result.approved) {
        return JSON.stringify({
          denied: true,
          reason: result.userId ? "Denied by user" : "Timed out",
        });
      }

      return (baseTool.execute as Function)(originalArgs, execCtx);
    },
  };
}
