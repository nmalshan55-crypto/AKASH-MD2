const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const axios = require('axios');
const mongoose = require('mongoose');
const simpleGit = require('simple-git');
const { sms, downloadMediaMessage } = require("./msg");
const { makeid } = require("./Id");
const getFBInfo = require('@xaviabot/fb-downloader');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    DisconnectReason,
} = require('@whiskeysockets/baileys');

// ==================== MONGODB MODELS ====================
const sessionSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true, index: true },
    creds: { type: Object, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    status: { type: String, enum: ['active', 'inactive', 'logged_out'], default: 'active' }
});

const numberListSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true, index: true },
    addedAt: { type: Date, default: Date.now },
    lastConnected: { type: Date, default: Date.now }
});

const configSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedAt: { type: Date, default: Date.now }
});

const userConfigSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true, index: true },
    config: { type: Object, default: {} },
    updatedAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', sessionSchema);
const NumberList = mongoose.model('NumberList', numberListSchema);
const Config = mongoose.model('Config', configSchema);
const UserConfig = mongoose.model('UserConfig', userConfigSchema);

// ==================== CONFIGURATION ====================
const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'false',
    AUTO_UPDATE: 'true',
    AUTO_LIKE_EMOJI: ['🦚', '🛹', '🍹', '📱', '🍡', '🪇'],
    PREFIX: '.',
    MAX_RETRIES: 5,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/Eqv2HOSQt1TGvB4NHtmDjL?mode=hqrt2',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://pmd-img2url.koyeb.app/v/b8ef26cc29a3cd0b78dbe68cdca65abb.jpg',
    NEWSLETTER_JID: '120363401853152721@newsletter',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94724389699',
    OWNER_NAME: 'SHANUKA SHAMEEN',
    BOT_NAME: 'SO X MINI',
    BOT_EMOJI: '🦚',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbB8Sv72phHMubLEgH0F',
    DEV_NAME: 'SHANUKA SHAMEEN',
    STORE_NUMBER: '0724389699',
    STORE_CHANNEL: 'https://whatsapp.com/channel/0029Vb7baIUK5cD5vFLsBy3R',
    STORE_FACEBOOK: 'https://www.facebook.com/share/18ExNA4GkR/',
    RECONNECT_INTERVAL: 5000,
    CONNECTION_TIMEOUT: 30000,
    MAX_RECONNECT_ATTEMPTS: 10,
    BOT_FOOTER: '> *🦚 𝐒𝙾 𝚇 𝐌𝙸𝙽𝙸* | *𝐒𝙷𝙰𝙽𝚄𝙺𝙰 𝚂𝙷𝙰𝙼𝙴𝙴𝙽*',
    BOT_IMAGE: 'https://pmd-img2url.koyeb.app/v/b8ef26cc29a3cd0b78dbe68cdca65abb.jpg',
    AUTO_STATUS_VIEW: 'true',
    AUTO_STATUS_REACT: 'true',
    SHOW_LAST_SEEN: 'true',
    BUTTON_RESPONSE_MODE: 'button',
    BUTTON_ENABLED: 'true'
};

const defaultUserConfig = {
    PREFIX: '.',
    AUTO_VIEW_STATUS: true,
    AUTO_LIKE_STATUS: true,
    AUTO_RECORDING: false,
    AUTO_LIKE_EMOJI: ['🦚', '🛹', '🍹', '📱', '🍡', '🪇'],
    SHOW_LAST_SEEN: true,
    BUTTON_MODE: 'button'
};

const CURRENT_VERSION = '2.0.0';
const git = simpleGit();

// ==================== GLOBAL VARIABLES ====================
const activeSockets = new Map();
const socketCreationTime = new Map();
const reconnectAttempts = new Map();
const SESSION_BASE_PATH = './session';

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// ==================== USER CONFIG FUNCTIONS ====================
async function loadUserConfig(number) {
    try {
        const userConfig = await UserConfig.findOne({ number });
        if (userConfig) {
            return { ...defaultUserConfig, ...userConfig.config };
        }
        return { ...defaultUserConfig };
    } catch (error) {
        console.error(`Failed to load user config:`, error);
        return { ...defaultUserConfig };
    }
}

async function updateUserConfig(number, configData) {
    try {
        await UserConfig.findOneAndUpdate(
            { number },
            { number, config: configData, updatedAt: new Date() },
            { upsert: true }
        );
        return true;
    } catch (error) {
        console.error(`Failed to update user config:`, error);
        return false;
    }
}

// ==================== MONGODB SESSION FUNCTIONS ====================
async function saveSessionToMongoDB(number, creds) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.findOneAndUpdate(
            { number: sanitizedNumber },
            { number: sanitizedNumber, creds, updatedAt: new Date(), lastSeen: new Date(), status: 'active' },
            { upsert: true }
        );
        console.log(`✅ Session saved to MongoDB for ${sanitizedNumber}`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to save session:`, error);
        return false;
    }
}

async function loadSessionFromMongoDB(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({ number: sanitizedNumber, status: 'active' });
        if (session?.creds) {
            console.log(`✅ Session loaded from MongoDB for ${sanitizedNumber}`);
            return session.creds;
        }
        return null;
    } catch (error) {
        console.error(`❌ Failed to load session:`, error);
        return null;
    }
}

async function deleteSessionFromMongoDB(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.updateOne({ number: sanitizedNumber }, { status: 'logged_out', updatedAt: new Date() });
        await NumberList.deleteOne({ number: sanitizedNumber });
        
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
        
        console.log(`✅ Session deleted for ${sanitizedNumber}`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to delete session:`, error);
        return false;
    }
}

async function saveNumberToMongoDB(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await NumberList.findOneAndUpdate(
            { number: sanitizedNumber },
            { number: sanitizedNumber, lastConnected: new Date() },
            { upsert: true }
        );
        return true;
    } catch (error) {
        console.error(`❌ Failed to save number:`, error);
        return false;
    }
}

async function getAllNumbersFromMongoDB() {
    try {
        const numbers = await NumberList.find({});
        return numbers.map(n => n.number);
    } catch (error) {
        console.error(`❌ Failed to load numbers:`, error);
        return [];
    }
}

// ==================== UTILITY FUNCTIONS ====================
function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n${footer || `> *🦚 ${config.BOT_NAME}* | *${config.DEV_NAME}*`}`;
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

const shonux = {
    key: { remoteJid: "status@broadcast", participant: "0@s.whatsapp.net", fromMe: false, id: "META_AI_FAKE_ID" },
    message: {
        contactMessage: {
            displayName: config.OWNER_NAME,
            vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${config.OWNER_NAME}\nORG:Meta Platforms\nTEL;type=CELL;waid=13135550002:+1 313 555 0002\nEND:VCARD`
        }
    }
};

// ==================== RESPONSE FORMATTER ====================
async function sendResponse(socket, chatId, content, quotedMsg, options = {}) {
    try {
        const userId = chatId.split('@')[0];
        const userConfig = await loadUserConfig(userId);
        const useButtons = userConfig.BUTTON_MODE === 'button' && config.BUTTON_ENABLED === 'true';
        
        if (useButtons && options.buttons && options.buttons.length > 0) {
            const buttonMessage = {
                text: content,
                buttons: options.buttons,
                headerType: 1
            };
            if (options.image) buttonMessage.image = options.image;
            if (options.video) buttonMessage.video = options.video;
            if (options.audio) buttonMessage.audio = options.audio;
            if (options.caption) buttonMessage.caption = options.caption;
            return await socket.sendMessage(chatId, buttonMessage, { quoted: quotedMsg });
        } else {
            let formattedContent = content;
            if (options.buttons && options.buttons.length > 0 && !useButtons) {
                formattedContent += '\n\n*📱 Commands:*\n';
                for (const btn of options.buttons) {
                    if (btn.buttonId && !btn.buttonId.includes('http')) {
                        formattedContent += `▸ *${btn.buttonText.displayText}* → \`${btn.buttonId}\`\n`;
                    }
                }
            }
            return await socket.sendMessage(chatId, { text: formattedContent }, { quoted: quotedMsg });
        }
    } catch (error) {
        console.error('Send response error:', error);
        return await socket.sendMessage(chatId, { text: content }, { quoted: quotedMsg });
    }
}

// ==================== NEWSLETTER HANDLERS ====================
async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/sulamd48/database/refs/heads/main/newsletter_list.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        return [];
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;
        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        if (!allNewsletterJIDs.includes(message.key.remoteJid)) return;
        try {
            const emojis = ['🦚', '🛹', '🍹', '📱', '🍡', '🪇'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            if (message.newsletterServerId) {
                await socket.newsletterReactMessage(message.key.remoteJid, message.newsletterServerId.toString(), randomEmoji);
            }
        } catch (error) {}
    });
}

// ==================== ENHANCED STATUS HANDLERS ====================
async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
        
        try {
            const statusOwner = message.key.participant.split('@')[0];
            const userConfig = await loadUserConfig(statusOwner);
            
            if (userConfig.AUTO_VIEW_STATUS === true) {
                await socket.readMessages([message.key]);
            }
            
            if (userConfig.AUTO_LIKE_STATUS === true) {
                const randomEmoji = userConfig.AUTO_LIKE_EMOJI?.[Math.floor(Math.random() * userConfig.AUTO_LIKE_EMOJI.length)] || '🦚';
                await socket.sendMessage(message.key.remoteJid, { 
                    react: { text: randomEmoji, key: message.key } 
                }, { statusJidList: [message.key.participant] });
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

// ==================== COMMAND HANDLERS ====================
function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const type = getContentType(msg.message);
        if (type === 'ephemeralMessage') msg.message = msg.message.ephemeralMessage.message;
        
        const m = sms(socket, msg);
        let body = '';
        try {
            const msgType = getContentType(msg.message);
            if (msgType === 'conversation') body = msg.message.conversation || '';
            else if (msgType === 'imageMessage') body = msg.message.imageMessage.caption || '';
            else if (msgType === 'videoMessage') body = msg.message.videoMessage.caption || '';
            else if (msgType === 'extendedTextMessage') body = msg.message.extendedTextMessage.text || '';
            else if (msgType === 'buttonsResponseMessage') body = msg.message.buttonsResponseMessage.selectedButtonId || '';
            else if (msgType === 'listResponseMessage') body = msg.message.listResponseMessage.singleSelectReply.selectedRowId || '';
        } catch (e) { body = ''; }
        
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net') : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = config.OWNER_NUMBER;
        const prefix = config.PREFIX;
        const isCmd = body.startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';
        const args = body.trim().split(/ +/).slice(1);
        
        if (!command) return;
        
        try {
            // ==================== COMMAND HANDLER ====================
            switch (command) {

                // ==================== ALIVE COMMAND ====================
                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const captionText = `*🦚 𝐇𝐈 𝐈 𝐀𝐌 𝐒𝐎 𝐗 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 🛹*
*❪ 𝐒𝐎 𝐗 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐀𝐋𝐈𝐕𝐄 𝐒𝐓𝐀𝐓𝐔𝐒 ❫*

*╭──────────────▻*
*◈ 🤖 𝐁ᴏᴛ 𝐔ᴘ 𝐓ɪᴍᴇ =* ${hours}h ${minutes}m ${seconds}s
*◈ 🍹 𝐀ᴄᴛɪᴠᴇ 𝐁ᴏᴛꜱ =* ${activeSockets.size} 
*◈ 📱 𝐁ᴏᴛ 𝐕ᴇʀꜱʜɪᴏɴ =* ${CURRENT_VERSION}
*◈ 🍡 𝐁ᴏᴛ 𝐏ʟᴀᴛꜰᴏʀᴍ =* Heroku
*◈ 🪇 𝐁ᴏᴛ 𝐎ᴡɴᴇʀ =* ${config.OWNER_NUMBER}
*◈ 🦚 𝐎ᴡɴᴇʀ 𝐍ᴀᴍᴇ =* ${config.OWNER_NAME}
*╰──────────────▻*

> *🦚 𝐒𝙾 𝚇 𝐌𝙸𝙽𝙸* | *${config.DEV_NAME}*`;

                    await sendResponse(socket, from, captionText, msg, {
                        image: { url: config.BOT_IMAGE },
                        buttons: [
                            { buttonId: `${prefix}menu`, buttonText: { displayText: '📄 MENU' }, type: 1 },
                            { buttonId: `${prefix}owner`, buttonText: { displayText: '👑 OWNER' }, type: 1 }
                        ]
                    });
                    break;
                }

                // ==================== SETTINGS COMMAND ====================
                case 'settings':
                case 'setting': {
                    const adminNumbers = [config.OWNER_NUMBER];
                    const botNumber = socket.user.id.split(':')[0];
                    if (![botNumber, ...adminNumbers].includes(senderNumber)) {
                        return await sendResponse(socket, from, '❌ Only the bot or admins can use this command.', msg);
                    }

                    const userConfig = await loadUserConfig(senderNumber);

                    const keys = [
                        'PREFIX',
                        'AUTO_VIEW_STATUS',
                        'AUTO_LIKE_STATUS',
                        'AUTO_RECORDING',
                        'SHOW_LAST_SEEN',
                        'BUTTON_MODE'
                    ];

                    const emojiMap = {
                        PREFIX: '🔑',
                        AUTO_VIEW_STATUS: '👀',
                        AUTO_LIKE_STATUS: '❤️',
                        AUTO_RECORDING: '🎙️',
                        AUTO_LIKE_EMOJI: '🦚',
                        SHOW_LAST_SEEN: '📱',
                        BUTTON_MODE: '🛹'
                    };

                    const onOff = v => v === true || v === 'true' ? '🟢 ON' : '🔴 OFF';
                    const modeDisplay = mode => mode === 'button' ? '🟢 BUTTON MODE' : '🔴 TEXT MODE';

                    let settingsText = `╭━━━[ *🛠️ YOUR SETTINGS* ]━━━⬣\n`;
                    settingsText += `┃ 👤 *Number:* ${senderNumber}\n`;
                    settingsText += `┃ 🤖 *Bot:* ${config.BOT_NAME}\n`;
                    settingsText += `┣━━━━━━━━━━━━━━━━━━━━━━╢\n`;

                    for (const key of keys) {
                        let value = userConfig[key];
                        if (key === 'AUTO_LIKE_EMOJI' && Array.isArray(value)) {
                            settingsText += `┃ ${emojiMap[key]} *${key}:* ${value.join(' ')}\n`;
                        } else if (key === 'BUTTON_MODE') {
                            settingsText += `┃ ${emojiMap[key]} *${key}:* ${modeDisplay(value)}\n`;
                        } else if (typeof value === 'boolean' || value === 'true' || value === 'false') {
                            settingsText += `┃ ${emojiMap[key]} *${key}:* ${onOff(value)}\n`;
                        } else {
                            settingsText += `┃ ${emojiMap[key]} *${key}:* ${value}\n`;
                        }
                    }

                    settingsText += `╰━━━━━━━━━━━━━━━━━━━━━━⬣\n\n`;
                    settingsText += `*📱 Commands:*\n`;
                    settingsText += `▸ \`.set <key> <value>\` - Change setting\n`;
                    settingsText += `▸ \`.lastseen on/off\` - Toggle last seen\n`;
                    settingsText += `▸ \`.statusview on/off\` - Toggle status view\n\n`;
                    settingsText += `*🦚 Available Emojis:* 🦚 🛹 🍹 📱 🍡 🪇\n\n`;
                    settingsText += `> *🦚 SO X MINI* | *SHANUKA SHAMEEN*`;

                    await sendResponse(socket, from, settingsText, msg, {
                        buttons: [
                            { buttonId: `${prefix}set AUTO_LIKE_EMOJI 🦚🛹🍹📱🍡🪇`, buttonText: { displayText: '🦚 SET EMOJIS' }, type: 1 },
                            { buttonId: `${prefix}set BUTTON_MODE text`, buttonText: { displayText: '📱 TEXT MODE' }, type: 1 },
                            { buttonId: `${prefix}set BUTTON_MODE button`, buttonText: { displayText: '🛹 BUTTON MODE' }, type: 1 }
                        ]
                    });
                    break;
                }

                // ==================== SET COMMAND ====================
                case 'set': {
                    const adminNumbers = [config.OWNER_NUMBER];
                    const botNumber = socket.user.id.split(':')[0];
                    if (![botNumber, ...adminNumbers].includes(senderNumber)) {
                        return await sendResponse(socket, from, '❌ Only the bot or admins can use this command.', msg);
                    }
                    if (args.length < 2) {
                        return await sendResponse(socket, from, 
                            '*📱 SETTINGS USAGE*\n\n' +
                            '┏━━━━━━━━━━━━━━━━━┓\n' +
                            '┃ *Format:* `.set <key> <value>`\n' +
                            '┃\n' +
                            '┃ *Available Keys:*\n' +
                            '┃ ▸ AUTO_VIEW_STATUS (true/false)\n' +
                            '┃ ▸ AUTO_LIKE_STATUS (true/false)\n' +
                            '┃ ▸ AUTO_LIKE_EMOJI (🦚🛹🍹📱🍡🪇)\n' +
                            '┃ ▸ BUTTON_MODE (button/text)\n' +
                            '┃ ▸ SHOW_LAST_SEEN (true/false)\n' +
                            '┗━━━━━━━━━━━━━━━━━┛\n\n' +
                            '*Example:* `.set AUTO_LIKE_EMOJI 🦚🛹🍹📱🍡🪇`\n\n' +
                            '> *🛹 SO X MINI* | *SHANUKA SHAMEEN*',
                            msg
                        );
                    }
                    
                    const key = args[0].toUpperCase();
                    let value = args.slice(1).join(' ');
                    
                    if (key === 'AUTO_LIKE_EMOJI') {
                        const emojis = value.match(/[\u{1F300}-\u{1F9FF}]/gu) || [];
                        if (emojis.length === 0) {
                            return await socket.sendMessage(from, { 
                                text: '❌ Please provide valid emojis. Example: `.set AUTO_LIKE_EMOJI 🦚🛹🍹📱🍡🪇`'
                            }, { quoted: msg });
                        }
                        value = emojis;
                    } else if (value === 'true') {
                        value = true;
                    } else if (value === 'false') {
                        value = false;
                    } else if (!isNaN(value)) {
                        value = Number(value);
                    }

                    let userConfig = await loadUserConfig(senderNumber);

                    if (!(key in defaultUserConfig) && key !== 'AUTO_LIKE_EMOJI') {
                        return await socket.sendMessage(from, { 
                            text: `❌ Unknown setting: ${key}\nAvailable: PREFIX, AUTO_VIEW_STATUS, AUTO_LIKE_STATUS, AUTO_RECORDING, AUTO_LIKE_EMOJI, BUTTON_MODE, SHOW_LAST_SEEN`
                        }, { quoted: msg });
                    }

                    userConfig[key] = value;
                    await updateUserConfig(senderNumber, userConfig);
                    
                    const responseEmoji = key === 'AUTO_LIKE_EMOJI' ? '🦚' : '✅';
                    await socket.sendMessage(from, { react: { text: responseEmoji, key: msg.key } });
                    
                    let displayValue = value;
                    if (key === 'AUTO_LIKE_EMOJI' && Array.isArray(value)) {
                        displayValue = value.join(' ');
                    }
                    
                    await sendResponse(socket, from, 
                        `*${responseEmoji} SETTING UPDATED*\n\n` +
                        `┏━━━━━━━━━━━━━━━━━┓\n` +
                        `┃ 🔑 *Key:* ${key}\n` +
                        `┃ 📱 *Value:* ${displayValue}\n` +
                        `┗━━━━━━━━━━━━━━━━━┛\n\n` +
                        `> *🍹 SO X MINI* | *SHANUKA SHAMEEN*`,
                        msg
                    );
                    break;
                }

                // ==================== STATUS VIEW COMMAND ====================
                case 'statusview':
                case 'sv': {
                    const adminNumbers = [config.OWNER_NUMBER];
                    const botNumber = socket.user.id.split(':')[0];
                    
                    if (![botNumber, ...adminNumbers].includes(senderNumber)) {
                        return await sendResponse(socket, from, '❌ Only the bot or admins can use this command.', msg);
                    }
                    
                    const action = args[0]?.toLowerCase();
                    let userConfig = await loadUserConfig(senderNumber);
                    
                    if (action === 'on') {
                        userConfig.AUTO_VIEW_STATUS = true;
                        await updateUserConfig(senderNumber, userConfig);
                        await sendResponse(socket, from, 
                            '*👀 STATUS AUTO-VIEW ENABLED*\n\n' +
                            '✅ Status updates will now be automatically viewed.\n\n' +
                            '> *📱 SO X MINI* | *SHANUKA SHAMEEN*',
                            msg
                        );
                    } else if (action === 'off') {
                        userConfig.AUTO_VIEW_STATUS = false;
                        await updateUserConfig(senderNumber, userConfig);
                        await sendResponse(socket, from, 
                            '*🔒 STATUS AUTO-VIEW DISABLED*\n\n' +
                            '❌ Status updates will not be automatically viewed.\n\n' +
                            '> *🍡 SO X MINI* | *SHANUKA SHAMEEN*',
                            msg
                        );
                    } else {
                        const status = userConfig.AUTO_VIEW_STATUS ? '🟢 ENABLED' : '🔴 DISABLED';
                        await sendResponse(socket, from, 
                            '*👀 STATUS VIEW SETTINGS*\n\n' +
                            `┏━━━━━━━━━━━━━━━━━┓\n` +
                            `┃ 📱 Current Status: ${status}\n` +
                            `┃\n` +
                            `┃ *Commands:*\n` +
                            `┃ ▸ \`.statusview on\` - Enable auto view\n` +
                            `┃ ▸ \`.statusview off\` - Disable auto view\n` +
                            `┗━━━━━━━━━━━━━━━━━┛\n\n` +
                            `> *🪇 SO X MINI* | *SHANUKA SHAMEEN*`,
                            msg,
                            {
                                buttons: [
                                    { buttonId: `${prefix}statusview on`, buttonText: { displayText: '👀 ENABLE' }, type: 1 },
                                    { buttonId: `${prefix}statusview off`, buttonText: { displayText: '🔒 DISABLE' }, type: 1 }
                                ]
                            }
                        );
                    }
                    break;
                }

                // ==================== LAST SEEN COMMAND ====================
                case 'lastseen':
                case 'ls': {
                    const adminNumbers = [config.OWNER_NUMBER];
                    const botNumber = socket.user.id.split(':')[0];
                    
                    if (![botNumber, ...adminNumbers].includes(senderNumber)) {
                        return await sendResponse(socket, from, '❌ Only the bot or admins can use this command.', msg);
                    }
                    
                    const action = args[0]?.toLowerCase();
                    let userConfig = await loadUserConfig(senderNumber);
                    
                    if (action === 'on') {
                        userConfig.SHOW_LAST_SEEN = true;
                        await updateUserConfig(senderNumber, userConfig);
                        await sendResponse(socket, from, 
                            '*✅ LAST SEEN VISIBILITY ENABLED*\n\n' +
                            'Your last seen will now be visible to contacts.\n\n' +
                            '> *🦚 SO X MINI* | *SHANUKA SHAMEEN*',
                            msg
                        );
                    } else if (action === 'off') {
                        userConfig.SHOW_LAST_SEEN = false;
                        await updateUserConfig(senderNumber, userConfig);
                        await sendResponse(socket, from, 
                            '*🔒 LAST SEEN VISIBILITY DISABLED*\n\n' +
                            'Your last seen will now be hidden.\n\n' +
                            '> *🛹 SO X MINI* | *SHANUKA SHAMEEN*',
                            msg
                        );
                    } else {
                        const status = userConfig.SHOW_LAST_SEEN ? '🟢 VISIBLE' : '🔴 HIDDEN';
                        await sendResponse(socket, from, 
                            '*📱 LAST SEEN SETTINGS*\n\n' +
                            `┏━━━━━━━━━━━━━━━━━┓\n` +
                            `┃ Current Status: ${status}\n` +
                            `┃\n` +
                            `┃ *Commands:*\n` +
                            `┃ ▸ \`.lastseen on\` - Show last seen\n` +
                            `┃ ▸ \`.lastseen off\` - Hide last seen\n` +
                            `┗━━━━━━━━━━━━━━━━━┛\n\n` +
                            `> *🍹 SO X MINI* | *SHANUKA SHAMEEN*`,
                            msg,
                            {
                                buttons: [
                                    { buttonId: `${prefix}lastseen on`, buttonText: { displayText: '🟢 SHOW' }, type: 1 },
                                    { buttonId: `${prefix}lastseen off`, buttonText: { displayText: '🔴 HIDE' }, type: 1 }
                                ]
                            }
                        );
                    }
                    break;
                }

                // ==================== MENU COMMAND ====================
                case 'menu': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    
                    const captionText = `*🦚 𝐇𝐈 𝐈 𝐀𝐌 𝐒𝐎 𝐗 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 🛹*
*❪ 𝐒𝐎 𝐗 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐌𝐄𝐍𝐔 ❫*

*╭──────────────►*
*◈ 🤖 𝐁ᴏᴛ 𝐔ᴘ 𝐓ɪᴍᴇ =* ${hours}h ${minutes}m ${seconds}s
*◈ 🍹 𝐀ᴄᴛɪᴠᴇ 𝐁ᴏᴛꜱ =* ${activeSockets.size} 
*◈ 📱 𝐁ᴏᴛ 𝐕ᴇʀꜱʜɪᴏɴ =* ${CURRENT_VERSION}
*◈ 🍡 𝐁ᴏᴛ 𝐏ʟᴀᴛꜰᴏʀᴍ =* Heroku
*◈ 🪇 𝐁ᴏᴛ 𝐎ᴡɴᴇʀ =* ${config.OWNER_NUMBER}
*◈ 🦚 𝐎ᴡɴᴇʀ 𝐍ᴀᴍᴇ =* ${config.OWNER_NAME}
*╰──────────────►*

*📱 AVAILABLE COMMANDS:* 
▸ .alive - Bot status
▸ .menu - Show menu
▸ .settings - View settings
▸ .statusview - Toggle status view
▸ .lastseen - Toggle last seen
▸ .song - Download songs
▸ .fb - Facebook video download
▸ .tiktok - TikTok video download
▸ .ig - Instagram download
▸ .ytvideo - YouTube video download
▸ .fancy - Fancy text converter
▸ .owner - Contact owner
▸ .ping - Check bot ping

> *🦚 𝐒𝙾 𝚇 𝐌𝙸𝙽𝙸* | *𝐒𝙷𝙰𝙽𝚄𝙺𝙰 𝚂𝙷𝙰𝙼𝙴𝙴𝙽*`;

                    await sendResponse(socket, from, captionText, msg, {
                        image: { url: config.BOT_IMAGE },
                        buttons: [
                            { buttonId: `${prefix}alive`, buttonText: { displayText: '🦚 ALIVE' }, type: 1 },
                            { buttonId: `${prefix}settings`, buttonText: { displayText: '🛹 SETTINGS' }, type: 1 },
                            { buttonId: `${prefix}statusview`, buttonText: { displayText: '👀 STATUS' }, type: 1 }
                        ]
                    });
                    break;
                }

                // ==================== OWNER COMMAND ====================
                case 'owner': {
                    const ownerNumber = config.OWNER_NUMBER;
                    const ownerName = config.OWNER_NAME;
                    const organization = '*🦚 𝐒𝙾 𝚇 𝐌𝙸𝙽𝙸 𝐁𝙾𝚃*';

                    const vcard = 'BEGIN:VCARD\n' +
                                  'VERSION:3.0\n' +
                                  `FN:${ownerName}\n` +
                                  `ORG:${organization};\n` +
                                  `TEL;type=CELL;type=VOICE;waid=${ownerNumber.replace('+', '')}:${ownerNumber}\n` +
                                  'END:VCARD';

                    try {
                        const sent = await socket.sendMessage(from, {
                            contacts: {
                                displayName: ownerName,
                                contacts: [{ vcard }]
                            }
                        });

                        await socket.sendMessage(from, {
                            text: `*🦚 𝐒𝐎 𝐗 𝐌𝐈𝐍𝐈 𝐁𝐨𝐭 𝐎𝐰𝐧𝐞𝐫 🛹*\n\n*👨‍🔧 𝐍𝐚𝐦𝐞:* ${ownerName}\n*💭 𝐍𝐮𝐦𝐛𝐞𝐫:* ${ownerNumber}\n\n> *🍹 SO X MINI* | *${config.DEV_NAME}*`,
                            contextInfo: {
                                mentionedJid: [`${ownerNumber.replace('+', '')}@s.whatsapp.net`],
                                quotedMessageId: sent.key.id
                            }
                        }, { quoted: msg });

                    } catch (err) {
                        console.error('❌ Owner command error:', err.message);
                        await socket.sendMessage(from, {
                            text: '❌ Error sending owner contact.'
                        }, { quoted: msg });
                    }
                    break;
                }

                // ==================== SONG COMMAND ====================
                case 'song': {
                    await socket.sendMessage(from, { react: { text: '🎧', key: msg.key } });
                    
                    const q = args.join(" ");
                    if (!args[0]) {
                        return await sendResponse(socket, from, 'Please enter YouTube song name or link !!', msg);
                    }
                    
                    try {
                        let videoId = null;
                        let videoUrl = null;
                        
                        if (q.includes("youtube.com") || q.includes("youtu.be")) {
                            const urlMatch = q.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
                            if (urlMatch) {
                                videoId = urlMatch[1];
                                videoUrl = `https://youtube.com/watch?v=${videoId}`;
                            }
                        }
                        
                        if (!videoId) {
                            const searchApi = `https://api.giftedtech.my.id/api/search/youtube?query=${encodeURIComponent(q)}`;
                            const searchRes = await axios.get(searchApi);
                            
                            if(!searchRes.data?.result?.[0]?.id) return await socket.sendMessage(from, {
                                text: '*📛 Please enter valid you tube song name or url.*'
                            });
                            
                            videoId = searchRes.data.result[0].id;
                            videoUrl = `https://youtube.com/watch?v=${videoId}`;
                        }
                        
                        const audioApi = `https://api.giftedtech.my.id/api/download/ytmp3?url=${encodeURIComponent(videoUrl)}`;
                        const data = await axios.get(audioApi);
                        
                        if(!data.data?.result) return await socket.sendMessage(from, {
                            text: '*📛 Failed to fetch song details.*'
                        });
                
                        const { title, image, duration, views, uploadDate, channel } = data.data.result;
                        
                        const caption = `*🎧 𝐒𝐎 𝐗 𝐌𝐈𝐍𝐈 𝐒𝐨𝐧𝐠 𝐃𝐨𝐰𝐧𝐥𝐨𝐚𝐝𝐞𝐫*\n\n` +
                              `*┏━━━━━━━━━━━━━━━*\n` +
                              `*◈ 🍂 𝐓𝐢𝐭𝐥𝐞:* ${title || "No info"}*\n` +
                              `*◈ ⏰ 𝐃𝐮𝐫𝐚𝐭𝐢𝐨𝐧:* ${duration || "No info"}*\n` +
                              `*◈ 📅 𝐔𝐩𝐥𝐨𝐚𝐝 𝐃𝐚𝐭𝐞:* ${uploadDate || "No info"}*\n` +
                              `*◈ 👀 𝐕𝐢𝐞𝐰𝐬:* ${views || "No info"}*\n` +
                              `*◈ 👤 𝐀𝐮𝐭𝐡𝐨𝐫:* ${channel || "No info"}*\n` +
                              `*┗━━━━━━━━━━━━━━━━━━*\n\n> *🦚 SO X MINI* | *${config.DEV_NAME}*`;
                          
                        const downloadUrl = data.data.result.download?.url;
                          
                        await sendResponse(socket, from, caption, msg, {
                            image: { url: image },
                            buttons: [
                                { buttonId: `${prefix}yt_mp3 AUDIO ${downloadUrl}`, buttonText: { displayText: '🎧 AUDIO TYPE' }, type: 1 },
                                { buttonId: `${prefix}yt_mp3 DOCUMENT ${downloadUrl}`, buttonText: { displayText: '📂 DOCUMENT TYPE' }, type: 1 },
                                { buttonId: `${prefix}yt_mp3 VOICECUT ${downloadUrl}`, buttonText: { displayText: '🎤 VOICE CUT' }, type: 1 }
                            ]
                        });
                        
                    } catch (e) {
                        console.log("❌ Song command error: " + e);
                        await socket.sendMessage(from, {
                            text: '❌ Error occurred while processing song request.'
                        }, { quoted: msg });
                    }
                    break;
                }

                // ==================== YT MP3 HANDLER ====================
                case 'yt_mp3': {
                    await socket.sendMessage(from, { react: { text: '📥', key: msg.key } });
                    const mediatype = args[0];
                    const downloadUrl = args[1];
                    
                    try {
                        if (mediatype === "AUDIO") {
                            await socket.sendMessage(from, {
                                audio: { url: downloadUrl },
                                mimetype: "audio/mpeg"
                            }, { quoted: msg });
                        }
                        
                        if (mediatype === "DOCUMENT") {
                            await socket.sendMessage(from, {
                                document: { url: downloadUrl },
                                mimetype: "audio/mpeg",
                                fileName: `🦚 SO X MINI_Song.mp3`,
                                caption: `*📂 Here is your YouTube Song Document*\n\n> *🛹 SO X MINI* | *${config.DEV_NAME}*`
                            }, { quoted: msg });
                        }
                        
                        if (mediatype === "VOICECUT") {
                            await socket.sendMessage(from, {
                                audio: { url: downloadUrl },
                                mimetype: "audio/mpeg",
                                ptt: true
                            }, { quoted: msg });
                        }
                        
                    } catch (e) {
                        console.log("❌ Song command error: " + e);
                    }
                    break;
                }

                // ==================== FACEBOOK COMMANDS ====================
                case 'fb': {
                    if (!args[0] || !args[0].startsWith('http')) {
                        return await sendResponse(socket, from, '❎ *Please provide a valid Facebook video link.*\n\n🍂 *Example:* `.fb https://fb.watch/abcd1234/`', msg);
                    }

                    try {
                        await socket.sendMessage(from, { react: { text: "⏳", key: msg.key } });

                        const fb = await getFBInfo(args[0]);
                        const url = args[0];
                        const caption = `*🦚 SO X MINI FB Downloader*\n\n🍀 *Title:* ${fb.title}\n📎 *URL:* ${url}\n\n> *🛹 SO X MINI* | *${config.DEV_NAME}*`;

                        await sendResponse(socket, from, caption, msg, {
                            image: { url: fb.thumbnail },
                            buttons: [
                                { buttonId: `.fbsd ${url}`, buttonText: { displayText: '📹 SD VIDEO' }, type: 1 },
                                { buttonId: `.fbhd ${url}`, buttonText: { displayText: '🔋 HD VIDEO' }, type: 1 },
                                { buttonId: `.fbaudio ${url}`, buttonText: { displayText: '🎵 AUDIO' }, type: 1 }
                            ]
                        });

                    } catch (e) {
                        console.error('FB command error:', e);
                        return await socket.sendMessage(from, { text: '❌ *Error occurred while processing the Facebook video link.*' });
                    }
                    break;
                }

                case 'fbsd': {
                    const url = args[0];
                    if (!url || !url.startsWith('http')) return await socket.sendMessage(from, { text: '❌ *Invalid Facebook video URL.*' });
                    try {
                        const res = await getFBInfo(url);
                        await socket.sendMessage(from, { video: { url: res.sd }, caption: '✅ *Here is your SD video!*' }, { quoted: msg });
                    } catch (err) {
                        console.error(err);
                        await socket.sendMessage(from, { text: '❌ *Failed to fetch SD video.*' });
                    }
                    break;
                }

                case 'fbhd': {
                    const url = args[0];
                    if (!url || !url.startsWith('http')) return await socket.sendMessage(from, { text: '❌ *Invalid Facebook video URL.*' });
                    try {
                        const res = await getFBInfo(url);
                        await socket.sendMessage(from, { video: { url: res.hd }, caption: '*🔋 Here is your HD Video*' }, { quoted: msg });
                    } catch (err) {
                        console.error(err);
                        await socket.sendMessage(from, { text: '❌ *Failed to fetch HD video.*' });
                    }
                    break;
                }

                case 'fbaudio': {
                    const url = args[0];
                    if (!url || !url.startsWith('http')) return await socket.sendMessage(from, { text: '❌ *Invalid Facebook video URL.*' });
                    try {
                        const res = await getFBInfo(url);
                        await socket.sendMessage(from, { audio: { url: res.sd }, mimetype: 'audio/mpeg' }, { quoted: msg });
                    } catch (err) {
                        console.error(err);
                        await socket.sendMessage(from, { text: '❌ *Failed to extract audio.*' });
                    }
                    break;
                }

                // ==================== TIKTOK COMMAND ====================
                case 'tiktok':
                case 'ttdl':
                case 'tt':
                case 'tiktokdl': {
                    try {
                        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
                        const q = text.split(" ").slice(1).join(" ").trim();

                        if (!q) {
                            return await sendResponse(socket, from, '*🚫 Please provide a TikTok video link.*', msg);
                        }

                        if (!q.includes("tiktok.com")) {
                            return await sendResponse(socket, from, '*🚫 Invalid TikTok link.*', msg);
                        }

                        await socket.sendMessage(from, { react: { text: '🎵', key: msg.key } });
                        await socket.sendMessage(from, { text: '*⏳ Downloading TikTok video...*' });

                        const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(q)}`;
                        const { data } = await axios.get(apiUrl);

                        if (!data.status || !data.data) {
                            return await sendResponse(socket, from, '*🚩 Failed to fetch TikTok video.*', msg);
                        }

                        const { title, like, comment, share, author, meta } = data.data;
                        const videoUrl = meta.media.find(v => v.type === "video").org;

                        const caption = `*🦚 SO X MINI TikTok Downloader*\n\n` +
                                        `┏━━━━━━━━━━━━━━━━\n` +
                                        `◈ 👤 *User:* ${author.nickname} (@${author.username})\n` +
                                        `◈ 📖 *Title:* ${title}\n` +
                                        `◈ 👍 *Likes:* ${like}\n` +
                                        `◈ 💬 *Comments:* ${comment}\n` +
                                        `◈ 🔁 *Shares:* ${share}\n` +
                                        `┗━━━━━━━━━━━━━━━━\n\n` +
                                        `> *🛹 SO X MINI* | *${config.DEV_NAME}*`;

                        await sendResponse(socket, from, caption, msg, {
                            video: { url: videoUrl },
                            buttons: [
                                { buttonId: `${prefix}menu`, buttonText: { displayText: '📄 MENU' }, type: 1 }
                            ]
                        });

                    } catch (err) {
                        console.error("Error in TikTok downloader:", err);
                        await sendResponse(socket, from, '*❌ Internal Error. Please try again later.*', msg);
                    }
                    break;
                }

                // ==================== INSTAGRAM COMMAND ====================
                case 'ig':
                case 'instagram':
                case 'igdl': {
                    try {
                        const q = args.join(" ");
                        if (!q) {
                            return await sendResponse(socket, from, '*🚫 Please provide an Instagram video/reel link.*\n\n📌 *Example:* `.ig https://www.instagram.com/reel/xyz`', msg);
                        }

                        if (!q.includes("instagram.com")) {
                            return await sendResponse(socket, from, '*🚫 Invalid Instagram link.*', msg);
                        }

                        await socket.sendMessage(from, { react: { text: '📸', key: msg.key } });
                        await socket.sendMessage(from, { text: '*⏳ Downloading Instagram video...*' });

                        const apiUrl = `https://delirius-apiofc.vercel.app/download/ig?url=${encodeURIComponent(q)}`;
                        const { data } = await axios.get(apiUrl);

                        if (!data.status || !data.data) {
                            return await sendResponse(socket, from, '*🚩 Failed to fetch Instagram video.*', msg);
                        }

                        const videoUrl = data.data.url;

                        await socket.sendMessage(from, {
                            video: { url: videoUrl },
                            caption: `*📸 SO X MINI Instagram Downloader*\n\n> *🦚 SO X MINI* | *${config.DEV_NAME}*`
                        }, { quoted: msg });

                    } catch (err) {
                        console.error("Error in Instagram downloader:", err);
                        await sendResponse(socket, from, '*❌ Internal Error. Please try again later.*', msg);
                    }
                    break;
                }

                // ==================== YOUTUBE VIDEO COMMAND ====================
                case 'ytvideo':
                case 'ytv':
                case 'ytmp4': {
                    try {
                        const q = args.join(" ");
                        if (!q) {
                            return await sendResponse(socket, from, '*🚫 Please provide a YouTube video link.*\n\n📌 *Example:* `.ytvideo https://youtu.be/xyz`', msg);
                        }

                        await socket.sendMessage(from, { react: { text: '🎬', key: msg.key } });
                        await socket.sendMessage(from, { text: '*⏳ Downloading YouTube video...*' });

                        const apiUrl = `https://api.giftedtech.my.id/api/download/ytmp4?url=${encodeURIComponent(q)}`;
                        const { data } = await axios.get(apiUrl);

                        if (!data.result) {
                            return await sendResponse(socket, from, '*🚩 Failed to fetch YouTube video.*', msg);
                        }

                        const { title, image, download } = data.result;

                        await socket.sendMessage(from, {
                            video: { url: download.url },
                            caption: `*🎬 SO X MINI YouTube Video*\n\n📹 *Title:* ${title}\n\n> *🛹 SO X MINI* | *${config.DEV_NAME}*`,
                            thumbnail: { url: image }
                        }, { quoted: msg });

                    } catch (err) {
                        console.error("Error in YouTube video downloader:", err);
                        await sendResponse(socket, from, '*❌ Internal Error. Please try again later.*', msg);
                    }
                    break;
                }

                // ==================== FANCY COMMAND ====================
                case 'fancy': {
                    const q = msg.message?.conversation ||
                              msg.message?.extendedTextMessage?.text ||
                              msg.message?.imageMessage?.caption ||
                              msg.message?.videoMessage?.caption || '';

                    const text = q.trim().replace(/^.(fancy|fancy)\s+/i, "");

                    if (!text) {
                        return await sendResponse(socket, from, "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.fancy SO X MINI`", msg);
                    }

                    try {
                        const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
                        const response = await axios.get(apiUrl);

                        if (!response.data.status || !response.data.result) {
                            return await sendResponse(socket, from, "❌ *Error fetching fonts from API. Please try again later.*", msg);
                        }

                        const fontList = response.data.result
                            .slice(0, 10)
                            .map(font => `*${font.name}:*\n${font.result}`)
                            .join("\n\n");

                        const finalMessage = `*🎨 Fancy Fonts Converter*\n\n${fontList}\n\n> *🦚 SO X MINI* | *${config.DEV_NAME}*`;

                        await sendResponse(socket, from, finalMessage, msg);

                    } catch (err) {
                        console.error("Fancy Font Error:", err);
                        await sendResponse(socket, from, "⚠️ *An error occurred while converting to fancy fonts.*", msg);
                    }
                    break;
                }

                // ==================== PING COMMAND ====================
                case 'ping': {
                    const start = Date.now();
                    const loading = await socket.sendMessage(from, { text: "🦚 SO X MINI" }, { quoted: msg });
                    const end = Date.now();
                    const ping = end - start;

                    await socket.sendMessage(from, {
                        text: `*📡 Pong!*\n*⏱️ Latency:* ${ping}ms\n\n*🦚 SO X MINI Bot*`,
                        edit: loading.key
                    });
                    break;
                }

                // ==================== VV COMMAND ====================
                case 'vv': {
                    let quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || {};
                    if (!quoted) return m.reply('❌ *Reply to a view once message!*');
                    try {
                        let mediaMessage = null;
                        if (msg.message?.viewOnceMessage?.message) {
                            mediaMessage = msg.message.viewOnceMessage.message.imageMessage || msg.message.viewOnceMessage.message.videoMessage;
                        } else if (msg.message?.viewOnceMessageV2?.message) {
                            mediaMessage = msg.message.viewOnceMessageV2.message.imageMessage || msg.message.viewOnceMessageV2.message.videoMessage;
                        }
                        if (!mediaMessage) return m.reply('❌ *Not a view once message!*');
                        await m.reply('📥 *Downloading...*');
                        const stream = await downloadContentFromMessage(mediaMessage, mediaMessage.mimetype.split('/')[0]);
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        if (mediaMessage.mimetype?.startsWith('image/')) {
                            await socket.sendMessage(from, { image: buffer, caption: '✅ *View once image*' }, { quoted: m });
                        } else if (mediaMessage.mimetype?.startsWith('video/')) {
                            await socket.sendMessage(from, { video: buffer, caption: '✅ *View once video*' }, { quoted: m });
                        }
                    } catch (err) {
                        m.reply('❌ *Failed to download!*');
                    }
                    break;
                }

                // ==================== ABOUT COMMAND ====================
                case 'about': {
                    if (args.length < 1) {
                        return await sendResponse(socket, from, "📛 *Usage:* `.about <number>`\n🍂 *Example:* `.about ${config.OWNER_NUMBER}*`", msg);
                    }

                    const targetNumber = args[0].replace(/[^0-9]/g, '');
                    const targetJid = `${targetNumber}@s.whatsapp.net`;

                    await socket.sendMessage(from, { react: { text: "ℹ️", key: msg.key } });

                    try {
                        const statusData = await socket.fetchStatus(targetJid);
                        const about = statusData.status || 'No status available';
                        const setAt = statusData.setAt
                            ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss')
                            : 'Unknown';

                        let profilePicUrl;
                        try {
                            profilePicUrl = await socket.profilePictureUrl(targetJid, 'image');
                        } catch {
                            profilePicUrl = null;
                        }

                        const responseText = `*ℹ️ About Status for +${targetNumber}:*\n\n` +
                            `📝 *Status:* ${about}\n` +
                            `⏰ *Last Updated:* ${setAt}\n` +
                            (profilePicUrl ? `🖼 *Profile Pic:* ${profilePicUrl}` : '');

                        if (profilePicUrl) {
                            await socket.sendMessage(from, { image: { url: profilePicUrl }, caption: responseText }, { quoted: msg });
                        } else {
                            await sendResponse(socket, from, responseText, msg);
                        }
                    } catch (error) {
                        console.error(`Failed to fetch status for ${targetNumber}:`, error);
                        await sendResponse(socket, from, `❌ Failed to get about status for ${targetNumber}. Make sure the number is valid and has WhatsApp.`, msg);
                    }
                    break;
                }

                // ==================== CHANNEL REACT COMMAND ====================
                case 'chr': {
                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || '';

                    if (!q.includes(',')) return await sendResponse(socket, from, "❌ Please provide input like this:\n*chr <link>,<reaction>*", msg);

                    const link = q.split(",")[0].trim();
                    const react = q.split(",")[1].trim();

                    try {
                        const channelId = link.split('/')[4];
                        const messageId = link.split('/')[5];

                        const res = await socket.newsletterMetadata("invite", channelId);
                        const response = await socket.newsletterReactMessage(res.id, messageId, react);

                        await sendResponse(socket, from, `✅ Reacted with "${react}" successfully!`, msg);

                    } catch (e) {
                        console.log(e);
                        await sendResponse(socket, from, `❌ Error: ${e.message}`, msg);
                    }
                    break;
                }

                default:
                    break;
            }
        } catch (error) {
            console.error('Command error:', error);
            if (m && m.reply) m.reply('❌ An error occurred.');
        }
    });
}

// ==================== GROUP & CONNECTION FUNCTIONS ====================
async function joinGroup(socket) {
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) return { status: 'failed', error: 'Invalid invite link' };
    try {
        const response = await socket.groupAcceptInvite(inviteCodeMatch[1]);
        return response?.gid ? { status: 'success', gid: response.gid } : { status: 'failed', error: 'No response' };
    } catch (error) {
        return { status: 'failed', error: error.message };
    }
}

async function sendAdminConnectMessage(socket, number) {
    const admins = loadAdmins();
    const caption = formatMessage('💥 CONNECTED', `📞 Number: ${number}\n🤖 Bot: ${config.BOT_NAME}`, config.BOT_NAME);
    for (const admin of admins) {
        try {
            await socket.sendMessage(`${admin}@s.whatsapp.net`, { image: { url: config.RCD_IMAGE_PATH }, caption });
        } catch (error) {}
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`✅ ${number} Connected!`);
            reconnectAttempts.delete(number);
        }
        if (connection === 'close') {
            const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
            if (isLoggedOut) {
                console.log(`🚫 ${number} logged out. Deleting session...`);
                await deleteSessionFromMongoDB(number);
                activeSockets.delete(number);
                socketCreationTime.delete(number);
            } else {
                const attempts = (reconnectAttempts.get(number) || 0) + 1;
                if (attempts <= config.MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts.set(number, attempts);
                    console.log(`🔄 Reconnecting ${number} (${attempts}/${config.MAX_RECONNECT_ATTEMPTS})...`);
                    await delay(config.RECONNECT_INTERVAL);
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(number, mockRes);
                } else {
                    console.log(`❌ Max reconnection attempts for ${number}`);
                    reconnectAttempts.delete(number);
                }
            }
        }
    });
}

// ==================== MAIN PAIRING FUNCTION ====================
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    await fs.ensureDir(sessionPath);

    const restoredCreds = await loadSessionFromMongoDB(sanitizedNumber);
    if (restoredCreds) {
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`✅ Session loaded from MongoDB for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'fatal' });

    try {
        const socket = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari'),
            markOnlineOnConnect: true,
        });

        socketCreationTime.set(sanitizedNumber, Date.now());
        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);

        if (!socket.authState.creds.registered) {
            let code;
            let retries = 3;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    if (retries === 0) {
                        if (!res.headersSent) res.status(500).send({ error: 'Failed to generate pairing code' });
                        return;
                    }
                    await delay(2000);
                }
            }
            if (!res.headersSent) res.send({ code });
        } else {
            if (!res.headersSent) res.send({ status: 'connected', message: 'Already registered' });
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            await saveSessionToMongoDB(sanitizedNumber, JSON.parse(fileContent));
        });

        socket.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                await delay(3000);
                await joinGroup(socket);
                
                const newsletterList = await loadNewsletterJIDsFromRaw();
                for (const jid of newsletterList) {
                    try { await socket.newsletterFollow(jid); } catch (err) {}
                }
                
                activeSockets.set(sanitizedNumber, socket);
                await saveNumberToMongoDB(sanitizedNumber);
                
                await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: formatMessage(`💥 WELCOME TO ${config.BOT_NAME}`, `✅ Connected!\n🔢 Number: ${sanitizedNumber}`, config.BOT_NAME)
                }, { quoted: shonux });
                
                await sendAdminConnectMessage(socket, sanitizedNumber);
                console.log(`🎉 ${sanitizedNumber} is online!`);
            }
        });

        return socket;
    } catch (error) {
        console.error('Pairing error:', error);
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
    }
}

// ==================== API ROUTES ====================
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number parameter is required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitizedNumber)) {
        return res.status(200).send({ status: 'already_connected', message: 'Already connected' });
    }
    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys()),
        uptime: Object.fromEntries(Array.from(socketCreationTime.entries()).map(([num, time]) => [num, Math.floor((Date.now() - time) / 1000)]))
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: `✨ ${config.BOT_NAME} ✨ running | 👑 ${config.DEV_NAME}`,
        activeSessions: activeSockets.size,
        timestamp: getSriLankaTimestamp()
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        const numbers = await getAllNumbersFromMongoDB();
        if (numbers.length === 0) return res.status(404).send({ error: 'No numbers found' });
        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
            } else {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
                await delay(1000);
            }
        }
        res.status(200).send({ status: 'success', connections: results });
    } catch (error) {
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const sessions = await Session.find({ status: 'active' });
        if (sessions.length === 0) return res.status(404).send({ error: 'No active sessions found' });
        const results = [];
        for (const session of sessions) {
            const number = session.number;
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
            } else {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
                await delay(1000);
            }
        }
        res.status(200).send({ status: 'success', connections: results });
    } catch (error) {
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/disconnect/:number', async (req, res) => {
    const sanitizedNumber = req.params.number.replace(/[^0-9]/g, '');
    try {
        if (activeSockets.has(sanitizedNumber)) {
            const socket = activeSockets.get(sanitizedNumber);
            await socket.logout();
            socket.ws.close();
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            await deleteSessionFromMongoDB(sanitizedNumber);
            res.status(200).send({ status: 'success', message: `Bot ${sanitizedNumber} disconnected` });
        } else {
            res.status(404).send({ error: 'Bot not found' });
        }
    } catch (error) {
        res.status(500).send({ error: 'Failed to disconnect bot' });
    }
});

router.get('/update', async (req, res) => {
    await checkAndUpdate();
    res.status(200).send({ status: 'update_check_initiated' });
});

// ==================== AUTO UPDATE FUNCTION ====================
async function checkAndUpdate() {
    if (config.AUTO_UPDATE !== 'true') return;
    
    console.log('🔄 Checking for updates...');
    try {
        await git.fetch();
        const tags = await git.tags();
        const latestVersion = tags.all.length > 0 ? tags.all[tags.all.length - 1] : CURRENT_VERSION;
        
        let versionDoc = await Config.findOne({ key: 'bot_version' });
        const currentVersion = versionDoc ? versionDoc.value : CURRENT_VERSION;
        
        if (latestVersion !== currentVersion) {
            console.log(`🆕 New version detected! Updating from ${currentVersion} to ${latestVersion}...`);
            await git.pull();
            
            const { exec } = require('child_process');
            exec('npm install', async (error, stdout) => {
                if (error) {
                    console.error('❌ npm install failed:', error);
                    return;
                }
                console.log('📦 Dependencies updated:', stdout);
                
                await Config.findOneAndUpdate(
                    { key: 'bot_version' },
                    { key: 'bot_version', value: latestVersion, updatedAt: new Date() },
                    { upsert: true }
                );
                
                console.log('✅ Bot updated successfully! Restarting...');
                setTimeout(() => process.exit(0), 2000);
            });
        } else {
            console.log('✅ Bot is up to date!');
        }
    } catch (error) {
        console.error('❌ Update check failed:', error.message);
    }
}

// ==================== CLEANUP & AUTO-RECONNECT ====================
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch (error) {}
        activeSockets.delete(number);
    });
});

process.on('uncaughtException', (err) => console.error('❌ Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('❌ Unhandled rejection:', reason));

// Auto reconnect from MongoDB on startup
setTimeout(async () => {
    console.log('🔄 Checking for existing sessions in MongoDB...');
    const numbers = await getAllNumbersFromMongoDB();
    console.log(`📊 Found ${numbers.length} numbers to reconnect`);
    for (const number of numbers) {
        if (!activeSockets.has(number)) {
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            await delay(2000);
        }
    }
    // Check for updates after reconnecting
    await checkAndUpdate();
    setInterval(checkAndUpdate, 60 * 60 * 1000);
}, 10000);

// Health check interval
setInterval(() => {
    activeSockets.forEach((socket, number) => {
        if (!socket.ws || socket.ws.readyState !== 1) {
            activeSockets.delete(number);
            socketCreationTime.delete(number);
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            EmpirePair(number, mockRes).catch(err => console.error(`Failed to reconnect ${number}:`, err.message));
        }
    });
}, 30 * 60 * 1000);

module.exports = router;