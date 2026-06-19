const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const fs = require('fs');

let bot = null;
let chatId = null;

function initTelegramBot(token, configChatId, handleCommand, getStatus, getLeads, getModels, switchModel, toggleAi, startWhatsApp, stopWhatsApp) {
  if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN') {
    console.warn('[WARN] telegramBotToken not set or default in config.json. Telegram bot is disabled.');
    return;
  }

  bot = new TelegramBot(token, { polling: true });
  chatId = configChatId && configChatId !== 'YOUR_TELEGRAM_CHAT_ID' ? configChatId : null;

  console.log('[INFO] Telegram Bot initialized.');

  // Send startup message if chatId is configured
  if (chatId) {
    sendTelegramMessage('🤖 *Ghumakkars Chatbot Telegram Dashboard Started*');
    sendControlPanel();
  }

  // Listen for messages
  bot.on('message', async (msg) => {
    const text = msg.text?.trim();
    if (!text) return;

    // Dynamically store the chatId if not set, or update it
    if (!chatId) {
      chatId = msg.chat.id;
      console.log(`[TELEGRAM] Set active chatId to ${chatId}. Save this in config.json: "telegramChatId": "${chatId}"`);
      await bot.sendMessage(chatId, `✅ *Connected to Dashboard!* Active chat ID is set to: \`${chatId}\`.\nPlease update this in your \`config.json\` to persist notifications.`);
    }

    if (text === '/start' || text === '/menu') {
      sendControlPanel(msg.chat.id);
    }
  });

  // Handle inline buttons
  bot.on('callback_query', async (callbackQuery) => {
    const action = callbackQuery.data;
    const msg = callbackQuery.message;
    const cid = msg.chat.id;

    try {
      await bot.answerCallbackQuery(callbackQuery.id);
    } catch (e) { /* ignore expired query */ }

    try {
      if (action === 'status') {
        const statusText = await getStatus();
        await bot.sendMessage(cid, statusText, { parse_mode: 'Markdown' });
      } else if (action === 'leads') {
        const leadsText = await getLeads();
        await bot.sendMessage(cid, leadsText, { parse_mode: 'Markdown' });
      } else if (action === 'toggle_ai') {
        const res = toggleAi();
        await bot.sendMessage(cid, `🤖 AI Replies: *${res ? 'ENABLED' : 'DISABLED'}*`, { parse_mode: 'Markdown' });
        sendControlPanel(cid, msg.message_id);
      } else if (action === 'start_wa') {
        const res = startWhatsApp();
        await bot.sendMessage(cid, `🟢 *WhatsApp Bot:* ${res}`);
        sendControlPanel(cid, msg.message_id);
      } else if (action === 'stop_wa') {
        const res = stopWhatsApp();
        await bot.sendMessage(cid, `🔴 *WhatsApp Bot:* ${res}`);
        sendControlPanel(cid, msg.message_id);
      } else if (action === 'select_model') {
        const models = getModels();
        const keyboard = models.map(m => [{
          text: `${m.active ? '✅ ' : ''}${m.name}`,
          callback_data: `set_model_${m.id}`
        }]);
        keyboard.push([{ text: '🔙 Back to Menu', callback_data: 'main_menu' }]);

        await bot.editMessageText('🤖 *Select AI Model:*', {
          chat_id: cid,
          message_id: msg.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
      } else if (action === 'main_menu') {
        sendControlPanel(cid, msg.message_id);
      } else if (action.startsWith('set_model_')) {
        const modelId = parseInt(action.replace('set_model_', ''), 10);
        const modelName = switchModel(modelId);
        if (modelName) {
          await bot.sendMessage(cid, `✅ Switched AI model to: *${modelName}*`, { parse_mode: 'Markdown' });
        } else {
          await bot.sendMessage(cid, `❌ Error switching model.`);
        }
        sendControlPanel(cid, msg.message_id);
      }
    } catch (e) {
      console.error('[TELEGRAM ERROR] Callback action error:', e.message);
    }
  });
}

function sendControlPanel(targetId = chatId, editMessageId = null) {
  if (!bot || !targetId) return;

  const text = `🛠 *Ghumakkars WhatsApp Bot Control Panel*\n\nChoose an action from the buttons below:`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: 'status' },
        { text: '🔥 Hot Leads', callback_data: 'leads' }
      ],
      [
        { text: '🤖 Select Model', callback_data: 'select_model' },
        { text: '⚙️ Toggle AI', callback_data: 'toggle_ai' }
      ],
      [
        { text: '🟢 Start WA', callback_data: 'start_wa' },
        { text: '🔴 Stop WA', callback_data: 'stop_wa' }
      ]
    ]
  };

  if (editMessageId) {
    bot.editMessageText(text, {
      chat_id: targetId,
      message_id: editMessageId,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup
    }).catch(() => {});
  } else {
    bot.sendMessage(targetId, text, {
      parse_mode: 'Markdown',
      reply_markup: replyMarkup
    });
  }
}

async function sendTelegramMessage(text) {
  if (!bot || !chatId) return;
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('[TELEGRAM ERROR] Failed to send message:', e.message);
  }
}

async function sendTelegramQrCode(qrString) {
  if (!bot || !chatId) return;
  try {
    const buffer = await QRCode.toBuffer(qrString, { width: 300 });
    await bot.sendPhoto(chatId, buffer, {
      caption: '🔑 *WhatsApp QR Login*\nScan this QR code in WhatsApp to link your device.'
    });
  } catch (e) {
    console.error('[TELEGRAM ERROR] Failed to send QR code photo:', e.message);
  }
}

module.exports = {
  initTelegramBot,
  sendTelegramMessage,
  sendTelegramQrCode
};
