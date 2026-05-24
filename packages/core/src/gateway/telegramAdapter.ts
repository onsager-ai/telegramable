import { Bot, type BotConfig, Context } from "grammy";
import type { Update, ReactionTypeEmoji } from "grammy/types";
import { IMAdapter, IMAdapterStartOptions, IMMessage } from "./types";
import { Logger } from "../logging";

export class TelegramAdapter implements IMAdapter {
  private bot?: Bot;

  constructor(
    public readonly id: string,
    private readonly token: string,
    private readonly logger: Logger,
    private readonly allowedUserIds?: string[],
    private readonly botConfig?: BotConfig<Context>
  ) { }

  private isUserAllowed(userId: string | undefined): boolean {
    if (!this.allowedUserIds || this.allowedUserIds.length === 0) return true;
    return userId !== undefined && this.allowedUserIds.includes(userId);
  }

  async start(onMessage: (message: IMMessage) => void, options?: IMAdapterStartOptions): Promise<void> {
    const polling = options?.polling ?? true;
    this.bot = new Bot(this.token, this.botConfig);

    this.bot.on("message:text", (ctx: Context) => {
      const message = ctx.message;
      if (!message?.text || !message.chat?.id) {
        return;
      }

      // Extract quoted/reply message text if the user replied to a message
      const replyMsg = "reply_to_message" in message
        ? (message.reply_to_message as { text?: string; caption?: string } | undefined)
        : undefined;
      const replyToText = replyMsg?.text || replyMsg?.caption || undefined;

      const payload: IMMessage = {
        channelId: this.id,
        chatId: String(message.chat.id),
        userId: message.from ? String(message.from.id) : undefined,
        text: message.text,
        messageId: message.message_id,
        threadId: message.message_thread_id,
        replyToText,
        raw: message
      };

      if (!this.isUserAllowed(payload.userId)) {
        this.logger.debug("Telegram message ignored (user not allowed).", { channelId: this.id, userId: payload.userId });
        return;
      }

      this.logger.debug("Telegram message received.", { channelId: this.id, chatId: payload.chatId });
      onMessage(payload);
    });

    this.bot.on("message:document", (ctx: Context) => {
      const message = ctx.message;
      if (!message?.document || !message.chat?.id) {
        return;
      }

      const payload: IMMessage = {
        channelId: this.id,
        chatId: String(message.chat.id),
        userId: message.from ? String(message.from.id) : undefined,
        text: message.caption || "",
        messageId: message.message_id,
        threadId: message.message_thread_id,
        fileId: message.document.file_id,
        fileName: message.document.file_name,
        mimeType: message.document.mime_type,
        raw: message
      };

      if (!this.isUserAllowed(payload.userId)) {
        this.logger.debug("Telegram document ignored (user not allowed).", { channelId: this.id, userId: payload.userId });
        return;
      }

      this.logger.debug("Telegram document received.", { channelId: this.id, chatId: payload.chatId });
      onMessage(payload);
    });

    this.bot.on("callback_query:data", (ctx: Context) => {
      const query = ctx.callbackQuery;
      if (!query?.data || !query.message?.chat?.id) {
        return;
      }

      const payload: IMMessage = {
        channelId: this.id,
        chatId: String(query.message.chat.id),
        userId: query.from ? String(query.from.id) : undefined,
        text: "",
        messageId: query.message.message_id,
        callbackData: query.data,
        callbackQueryId: query.id,
        raw: query
      };

      if (!this.isUserAllowed(payload.userId)) {
        this.logger.debug("Telegram callback query ignored (user not allowed).", { channelId: this.id, userId: payload.userId });
        return;
      }

      this.logger.debug("Telegram callback query received.", { channelId: this.id, chatId: payload.chatId });
      onMessage(payload);
    });

    this.bot.catch((err) => {
      this.logger.warn("Telegram bot error.", { channelId: this.id, message: err.message });
    });

    // Register command menu so users see shortcuts when typing "/"
    await this.registerCommands();

    if (polling) {
      // Start long-polling (non-blocking)
      this.bot.start({
        drop_pending_updates: true,
        onStart: () => {
          this.logger.info("Telegram adapter started.", { channelId: this.id });
        }
      });
    } else {
      await this.bot.init();
      this.logger.info("Telegram adapter started (no polling).", { channelId: this.id });
    }
  }

  /** Inject a raw Telegram Update into the bot's handler chain. For testing. */
  async handleUpdate(update: Update): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot not started.");
    await this.bot.handleUpdate(update);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.sendMessage(Number(chatId), text, { parse_mode: "HTML" });
  }

  async sendMessageWithMarkup(chatId: string, text: string, markup: unknown, options?: { threadId?: number }): Promise<number> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    const result = await this.bot.api.sendMessage(Number(chatId), text, {
      parse_mode: "HTML",
      reply_markup: markup as Parameters<Bot["api"]["sendMessage"]>[2] extends { reply_markup?: infer R } ? R : never,
      message_thread_id: options?.threadId
    });
    return result.message_id;
  }

  async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.editMessageText(Number(chatId), messageId, text, { parse_mode: "HTML" });
  }

  async editMessageWithMarkup(chatId: string, messageId: number, text: string, markup: unknown): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.editMessageText(Number(chatId), messageId, text, {
      parse_mode: "HTML",
      reply_markup: markup as Parameters<Bot["api"]["editMessageText"]>[3] extends { reply_markup?: infer R } ? R : never,
    });
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.deleteMessage(Number(chatId), messageId);
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.answerCallbackQuery(callbackQueryId, { text });
  }

  async sendDocument(chatId: string, file: Buffer | string, options?: { caption?: string; fileName?: string; threadId?: number }): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }

    const inputFile = typeof file === "string"
      ? new (await import("grammy")).InputFile(file, options?.fileName)
      : new (await import("grammy")).InputFile(file, options?.fileName || "file");

    await this.bot.api.sendDocument(Number(chatId), inputFile, {
      caption: options?.caption,
      message_thread_id: options?.threadId
    });
  }

  async getFileUrl(fileId: string): Promise<string> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error("File path not available.");
    }
    return `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
  }

  async createForumTopic(chatId: string, name: string): Promise<number> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    const topic = await this.bot.api.createForumTopic(Number(chatId), name);
    return topic.message_thread_id;
  }

  async sendChatAction(chatId: string, action: string, options?: { threadId?: number }): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.sendChatAction(Number(chatId), action as Parameters<Bot["api"]["sendChatAction"]>[1], {
      message_thread_id: options?.threadId
    });
  }

  async setMessageReaction(chatId: string, messageId: number, emoji: string | null): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    const reaction = emoji
      ? [{ type: "emoji" as const, emoji: emoji as ReactionTypeEmoji["emoji"] }]
      : [];
    await this.bot.api.setMessageReaction(Number(chatId), messageId, reaction);
  }

  async sendMessageDraft(chatId: string, draftId: number, text: string, options?: { threadId?: number }): Promise<number> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    const result = await (this.bot.api as any).raw.sendMessageDraft({
      chat_id: Number(chatId),
      draft_id: draftId,
      text,
      parse_mode: "HTML",
      message_thread_id: options?.threadId
    });
    return result.message_id;
  }

  async closeForumTopic(chatId: string, topicId: number): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started.");
    }
    await this.bot.api.closeForumTopic(Number(chatId), topicId);
  }

  /** Register bot commands with Telegram so users see the "/" shortcut menu. */
  private async registerCommands(): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.setMyCommands([
        { command: "new", description: "Start a new session" },
        { command: "sessions", description: "List and switch sessions" },
        { command: "stop", description: "Cancel the running task" },
        { command: "memory", description: "View and manage stored memories" },
        { command: "usage", description: "Token usage and cost" },
        { command: "help", description: "Show all commands" },
      ]);
      this.logger.debug("Telegram bot commands registered.", { channelId: this.id });
    } catch (err) {
      this.logger.warn("Failed to register Telegram bot commands.", {
        channelId: this.id,
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.bot) {
      return;
    }
    try {
      await this.bot.stop();
    } catch {
      // bot.stop() throws if polling was never started — safe to ignore
    }
    this.logger.info("Telegram adapter stopped.", { channelId: this.id });
  }
}
