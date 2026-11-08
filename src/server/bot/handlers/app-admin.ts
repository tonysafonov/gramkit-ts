import { randomUUID } from 'node:crypto';
import { Composer, InlineKeyboard } from 'grammy';
import { settings } from '../../config';
import { PaymentProvider, SubscriptionStatus } from '../../db/schema';
import { supportedLocale } from '../../lib/i18n';
import { getLogger } from '../../lib/logging';
import { buildKeyboardMarkup, entitiesToHtml } from '../../modules/broadcasts/formatting';
import type { BotContext } from '../context';
import { clearState, getData, inState, setState, updateData } from '../fsm';
import { adminMiddleware } from '../middlewares/admin';

const logger = getLogger('bot-app-admin');

const ownerOnly = () => adminMiddleware(() => settings.rbac.ownerIds);

/** The broadcast flow's FSM states. */
const WAITING_FOR_MESSAGE = 'waiting_for_message';
const WAITING_FOR_KEYBOARD = 'waiting_for_keyboard';
const CONFIRMATION = 'confirmation';

const DURATION_DAYS: Record<string, number> = { week: 7, month: 30, year: 365, max: 365 * 5 };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `YYYY-MM-DD HH:MM:SS` in UTC. */
const formatDateTime = (date: Date): string => date.toISOString().slice(0, 19).replace('T', ' ');

/** This app's admin commands: `/admin`, `/broadcast` (the FSM flow) and `/giftsub`. */
export const appAdminComposer = new Composer<BotContext>();

/** Shows all available admin commands. */
appAdminComposer.command('admin', ownerOnly(), async (ctx) => {
  await ctx.reply(
    '🔧 Admin Commands\n\n' +
      'Broadcasting:\n' +
      '• /broadcast - Send a message to all users now\n' +
      '• Scheduled broadcasts: the web admin, /admin/broadcasts\n\n' +
      'User Management:\n' +
      '• /giftsub <user\\_id> <week|month|year|max> - Gift subscription to user\n\n' +
      'Statistics:\n' +
      '• /stats - Daily digest so far (sent only to you)\n\n' +
      'This Menu:\n' +
      '• /admin - Show this admin commands list',
    { parse_mode: 'Markdown' },
  );
});

/** Initiates the broadcast flow. */
appAdminComposer.command('broadcast', ownerOnly(), async (ctx) => {
  await ctx.reply('Please forward the message you want to broadcast to all users.');
  setState(ctx, WAITING_FOR_MESSAGE);
});

/** The broadcast message: store it, ask about the keyboard. */
appAdminComposer.filter(inState(WAITING_FOR_MESSAGE)).on('message', async (ctx) => {
  const { message } = ctx;

  if (message.text) {
    // The raw text and the HTML version, to keep formatting like bold and italics
    if (message.entities?.length) {
      updateData(ctx, {
        message_type: 'text',
        message_text: message.text,
        message_html: entitiesToHtml(message.text, message.entities),
        has_formatting: true,
      });
    } else {
      updateData(ctx, { message_type: 'text', message_text: message.text, has_formatting: false });
    }
  } else if (message.photo) {
    const photo = message.photo[message.photo.length - 1]; // the largest
    const caption = message.caption ?? '';
    const hasCaptionFormatting = Boolean(message.caption_entities?.length);
    // Captions with entities are converted to HTML the same way
    const captionHtml =
      hasCaptionFormatting && caption ? entitiesToHtml(caption, message.caption_entities ?? []) : null;

    updateData(ctx, {
      message_type: 'photo',
      photo_file_id: photo?.file_id,
      caption,
      caption_html: captionHtml,
      has_caption_formatting: hasCaptionFormatting,
    });
  } else {
    await ctx.reply('Please send a text message or a photo with optional caption.');
    return;
  }

  const keyboard = new InlineKeyboard()
    .text('No keyboard', 'keyboard_none')
    .row()
    .text('Main menu keyboard', 'keyboard_main')
    .row()
    .text('Daily keyboard', 'keyboard_daily');

  await ctx.reply('Please select a keyboard to attach to the broadcast message:', { reply_markup: keyboard });
  setState(ctx, WAITING_FOR_KEYBOARD);
});

/** Keyboard selection: show the preview, ask for confirmation. */
appAdminComposer.filter(inState(WAITING_FOR_KEYBOARD)).on('callback_query', async (ctx) => {
  await ctx.answerCallbackQuery();
  const callbackData = ctx.callbackQuery.data;
  if (!callbackData || !ctx.callbackQuery.message || !ctx.user) return;

  updateData(ctx, { keyboard_type: callbackData.split('_')[1] });
  const data = getData(ctx);
  // The keyboard the job sends (the registry), in the admin's language.
  const replyMarkup =
    buildKeyboardMarkup(data, supportedLocale(ctx.user.languageCode || ctx.user.tgLanguageCode)) ?? undefined;

  if (data.message_type === 'photo') {
    const formatted = Boolean(data.has_caption_formatting);
    await ctx.replyWithPhoto(data.photo_file_id as string, {
      caption: (formatted ? (data.caption_html as string) : (data.caption as string | undefined)) ?? '',
      parse_mode: formatted ? 'HTML' : undefined,
      reply_markup: replyMarkup,
    });
  } else {
    const formatted = Boolean(data.has_formatting);
    const text = formatted ? data.message_html : data.message_text;
    await ctx.reply((text as string | undefined) || '', {
      parse_mode: formatted ? 'HTML' : undefined,
      reply_markup: replyMarkup,
    });
  }

  const confirmKeyboard = new InlineKeyboard()
    .text('✅ Confirm Broadcast', 'broadcast_confirm')
    .text('❌ Cancel', 'broadcast_cancel');
  await ctx.reply(
    'Above is a preview of your broadcast message. Would you like to proceed with sending it to all users?',
    {
      reply_markup: confirmKeyboard,
    },
  );
  setState(ctx, CONFIRMATION);
});

appAdminComposer.filter(inState(CONFIRMATION)).callbackQuery('broadcast_cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.callbackQuery.message) return;
  await ctx.reply('Broadcast cancelled.');
  clearState(ctx);
});

/** Confirmation: queue the broadcast job (a fast transaction). */
appAdminComposer.filter(inState(CONFIRMATION)).callbackQuery('broadcast_confirm', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.callbackQuery.message) return;

  const data = getData(ctx);
  try {
    await ctx.services.worker.enqueueJob('user_broadcast_job', {
      // run_id: the job skips users this run already reached if the queue re-runs it
      broadcast_data: { ...data, run_id: randomUUID().replaceAll('-', '') },
      requester_telegram_id: ctx.from.id,
    });

    await ctx.reply(
      '✅ Broadcast queued successfully!\n\n' +
        'The broadcast is now processing in the background. ' +
        "You'll receive a notification when it's complete.\n\n" +
        'This may take several minutes depending on the number of users.',
    );
    logger.info(`Broadcast job queued by admin ${ctx.from.id} (type: ${data.message_type})`);
  } catch (err) {
    logger.error({ err }, `Failed to queue broadcast job: ${errorText(err)}`);
    await ctx.reply('❌ Failed to queue broadcast job. Please try again or check logs.');
  }

  clearState(ctx);
});

/** Gift a subscription to a user. */
appAdminComposer.command('giftsub', ownerOnly(), async (ctx) => {
  const { user, services } = ctx;
  if (!user) return;

  // The replies are HTML by default, so the angle brackets are escaped
  if (!ctx.match) {
    await ctx.reply('Usage: /giftsub &lt;user_id&gt; &lt;week|month|year|max&gt;');
    return;
  }

  const args = ctx.match.split(/\s+/);
  if (args.length !== 2) {
    await ctx.reply('Invalid arguments. Usage: /giftsub &lt;user_id&gt; &lt;week|month|year|max&gt;');
    return;
  }
  const [userIdentifier, durationType] = args as [string, string];

  const durationDays = DURATION_DAYS[durationType];
  if (durationDays === undefined) {
    await ctx.reply('Invalid duration. Use week, month, year, or max');
    return;
  }

  if (!/^[+-]?\d+$/.test(userIdentifier)) {
    await ctx.reply('Invalid Telegram ID. Please provide a numeric Telegram ID');
    return;
  }
  const telegramId = Number(userIdentifier);
  const targetUser = await services.users.getByTelegramId(telegramId);
  if (!targetUser) {
    await ctx.reply(`User with Telegram ID ${telegramId} not found`);
    return;
  }

  try {
    const subscription = await services.subscriptions.getSubscriptionForUser(targetUser.id);
    const now = new Date();
    const days = durationDays * 24 * 60 * 60 * 1000;

    let endDate: Date;
    if (subscription && subscription.endDate > now) {
      // Extend the existing subscription
      endDate = new Date(subscription.endDate.getTime() + days);
      await services.repos.subscriptions.update(subscription.id, { endDate, status: SubscriptionStatus.ACTIVE });
    } else {
      endDate = new Date(now.getTime() + days);
      await services.repos.subscriptions.create({
        userId: targetUser.id,
        productId: 'GIFT_SUB',
        providerId: PaymentProvider.GIFT,
        status: SubscriptionStatus.ACTIVE,
        currency: 'RUB',
        startDate: now,
        endDate,
        recurringDetails: { gifted_by: user.id },
      });
    }

    // Update the user's onboarding status if needed
    await services.users.updateUser(targetUser.id, { isOnboarded: true });

    const usernameDisplay = targetUser.username ? `@${targetUser.username}` : 'No username';
    await ctx.reply(
      `✅ Successfully gifted ${durationType} subscription to user ${usernameDisplay}, telegram_id: ${targetUser.telegramId}.\n` +
        `Subscription active until: ${formatDateTime(endDate)}`,
    );
  } catch (err) {
    logger.error({ err }, `Failed to gift subscription: ${errorText(err)}`);
    await ctx.reply(`❌ Failed to gift subscription: ${errorText(err)}`);
  }
});
