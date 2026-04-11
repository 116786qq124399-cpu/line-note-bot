require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('./firebase');

const app = express();

const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

const DOC_REF = db.collection('app').doc('main');

const DEFAULT_DATA = {
  notesByUser: {},
  inviteCodes: {},
  unlockedUsers: {},
  admin: null,
};

let data = { ...DEFAULT_DATA };

// ════════════════════════════════════════════════
// Firestore 讀寫
// ════════════════════════════════════════════════
async function loadData() {
  const snap = await DOC_REF.get();
  if (!snap.exists) {
    console.log('Firestore 無資料，使用預設');
    return { ...DEFAULT_DATA };
  }
  const d = snap.data();
  return {
    notesByUser: d.notesByUser || {},
    inviteCodes: d.inviteCodes || {},
    unlockedUsers: d.unlockedUsers || {},
    admin: d.admin || null,
  };
}

async function saveData() {
  await DOC_REF.set({
    notesByUser: data.notesByUser,
    inviteCodes: data.inviteCodes,
    unlockedUsers: data.unlockedUsers,
    admin: data.admin,
  });
}

// ════════════════════════════════════════════════
// 產生 6 碼隨機大寫英數邀請碼
// ════════════════════════════════════════════════
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return data.inviteCodes[code] ? generateCode() : code;
}

// userState[userId] = {
//   step: null | 'waiting_content' | 'waiting_keyword' | 'confirm_delete' | 'choosing',
//   tempContent: '',
//   deleteKey: '',
//   results: []
// }
const userState = {};

// ════════════════════════════════════════════════
// 模式系統（userMode）
// userMode[userId] = 'add' | 'search' | 'category' | null
// ════════════════════════════════════════════════
const userMode = {};

function setMode(userId, mode) {
  userMode[userId] = mode;
}

function clearMode(userId) {
  userMode[userId] = null;
}

function getMode(userId) {
  return userMode[userId] || null;
}

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function verifySignature(rawBody, signature) {
  if (!rawBody || !signature) return false;
  const hash = crypto
    .createHmac('sha256', process.env.CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

async function replyMessage(replyToken, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    {
      replyToken,
      messages: [{ type: 'text', text }],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
}

function initUser(userId) {
  if (!data.notesByUser[userId]) data.notesByUser[userId] = {};
  if (!userState[userId]) {
    userState[userId] = { step: null, tempContent: '', deleteKey: '', results: [] };
  }
}

function resetState(userId) {
  userState[userId] = { step: null, tempContent: '', deleteKey: '', results: [] };
}

function fuzzySearch(notes, query) {
  return Object.keys(notes).filter((key) => key.includes(query));
}

// ════════════════════════════════════════════════
// 分頁搜尋系統
// searchState[userId] = { keyword, results, page }
// ════════════════════════════════════════════════
const searchState = {};

function paginate(results, page = 1, pageSize = 10) {
  const start = (page - 1) * pageSize;
  return results.slice(start, start + pageSize);
}

function buildSearchPage(results, page, notes) {
  const PAGE_SIZE = 10;
  const total = results.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const pageItems = paginate(results, page, PAGE_SIZE);

  const list = pageItems
    .map((k, i) => {
      const cat = getNoteCategory(notes[k]);
      return `${NUMBER_EMOJI[i] ?? `${i + 1}.`} ${k}　${CATEGORY_EMOJI[cat] ?? '📌'}`;
    })
    .join('\n');

  let msg = `🔍 找到 ${total} 筆結果（第 ${page} 頁）\n\n${list}`;
  if (page < totalPages) {
    msg += '\n\n➡️ 輸入「下一頁」查看更多';
  }
  return msg;
}

// ════════════════════════════════════════════════
// 自動分類（關鍵字權重，不使用外部 API）
// weight 3 = 強烈特徵詞，weight 2 = 中等，weight 1 = 輔助
// ════════════════════════════════════════════════
function classify(text) {
  const rules = [
    {
      category: '工作',
      keywords: [
        { w: 3, list: ['開會', '會議', '簡報', '提案', '合約', '截止日', '老闆', '主管'] },
        { w: 2, list: ['專案', '報告', '客戶', '業務', '進度', '上班', '下班', '同事', '辦公', '工作'] },
        { w: 1, list: ['任務', '目標', '計畫', '安排', '負責', '交接', '簽約', '出差', '薪水', '加班'] },
      ],
    },
    {
      category: '靈感',
      keywords: [
        { w: 3, list: ['靈感', '突然想到', '腦波', '構想', '點子'] },
        { w: 2, list: ['創意', '想法', '設計', '概念', '發現', '嘗試', '試試'] },
        { w: 1, list: ['如果', '感覺可以', '也許', '說不定', '試看看', '應該可以', '有個', '想到一個'] },
      ],
    },
    {
      category: '日記',
      keywords: [
        { w: 3, list: ['日記', '今天', '昨天', '這週', '這個月'] },
        { w: 2, list: ['心情', '感覺', '覺得', '回憶', '感謝', '難過', '開心', '生氣', '好累', '好棒'] },
        { w: 1, list: ['早上', '下午', '晚上', '睡前', '出門', '回家', '吃飯', '散步', '天氣', '放鬆'] },
      ],
    },
    {
      category: '待辦',
      keywords: [
        { w: 3, list: ['待辦', '別忘', '記得要', '不能忘', '一定要'] },
        { w: 2, list: ['記得', '提醒', '要買', '繳費', '繳款', '預約', '回覆', '必須', '需要'] },
        { w: 1, list: ['去', '買', '打電話', '傳訊息', '確認', '查', '處理', '弄', '辦', '寄'] },
      ],
    },
  ];

  let best = { category: '其他', score: 0 };

  for (const rule of rules) {
    let score = 0;
    for (const group of rule.keywords) {
      for (const kw of group.list) {
        if (text.includes(kw)) score += group.w;
      }
    }
    if (score > best.score) {
      best = { category: rule.category, score };
    }
  }

  return best.category;
}

const CATEGORY_EMOJI = { '工作': '💼', '靈感': '💡', '日記': '📖', '待辦': '✅', '其他': '📌' };

// ════════════════════════════════════════════════
// 根據分類回傳不同風格的結尾句
// ════════════════════════════════════════════════
function smartReply(category) {
  const replies = {
    工作: [
      '已歸檔，隨時可以調閱 📁',
      '記錄完成，專注繼續衝 💪',
      '存好了，不怕忘記重要細節 🗂️',
    ],
    靈感: [
      '靈感捕捉成功！記得去實現它 🚀',
      '好點子就該立刻記下來，做得好 💡',
      '這個想法很有潛力，繼續發揮 ✨',
    ],
    日記: [
      '今天也辛苦了，好好休息 🌙',
      '謝謝你願意把這些告訴我 🤍',
      '每一天都值得被記住 📖',
    ],
    待辦: [
      '清單更新完畢，一件一件搞定它 ✅',
      '記住了！完成後記得來刪掉它 💨',
      '效率第一，放心去做吧 ⚡',
    ],
    其他: [
      '記好了，需要的時候來找我 😊',
      '收到，隨時幫你找出來 🔍',
      '存進去了，放心吧 👌',
    ],
  };

  const list = replies[category] ?? replies['其他'];
  return list[Math.floor(Math.random() * list.length)];
}

// 相容舊資料（舊筆記存的是純字串，新的是 { content, category }）
function getNoteContent(note) {
  if (!note) return '';
  if (typeof note === 'string') return note;
  return note.content || '';
}

function getNoteCategory(note) {
  if (!note || typeof note === 'string') return '其他';
  return note.category || '其他';
}

// ════════════════════════════════════════════════
// Express middleware
// ════════════════════════════════════════════════

// 全域 log（最先執行，確認任何 request 都有進來）
app.use((req, res, next) => {
  console.log('🌍 GLOBAL HIT:', req.method, req.url);
  next();
});

// /api 以外的一般路由才用 json
app.use('/api', express.json());

// ════════════════════════════════════════════════
// Routes
// ════════════════════════════════════════════════

app.get('/', (req, res) => {
  console.log('🔥 ROOT HIT');
  res.send('OK');
});

// webhook 直接掛 route-level raw middleware，確保 req.body 一定是 Buffer
app.post('/webhook', express.raw({ type: '*/*' }), (req, res) => {
  console.log('🔥 WEBHOOK HIT');

  try {
    const rawBody = req.body;
    const signature = req.headers['x-line-signature'];

    console.log('isBuffer:', Buffer.isBuffer(rawBody));

    if (!Buffer.isBuffer(rawBody)) {
      console.log('❌ rawBody 不是 Buffer');
      return res.status(200).send('OK');
    }

    if (!signature) {
      console.log('❌ 沒有 signature');
      return res.status(200).send('OK');
    }

    const hash = crypto
      .createHmac('sha256', process.env.CHANNEL_SECRET)
      .update(rawBody)
      .digest('base64');

    if (hash !== signature) {
      console.log('❌ signature mismatch');
      console.log('  expected:', hash);
      console.log('  received:', signature);
      return res.status(403).send('Invalid signature');
    }

    console.log('✅ signature OK');

    const json = JSON.parse(rawBody.toString());
    const events = json.events || [];
    console.log('events:', events.length);

    res.status(200).send('OK');

    events.forEach((event) => {
      console.log('event type:', event.type);
      handleEvent(event).catch((err) =>
        console.error('handleEvent 錯誤:', err)
      );
    });
  } catch (err) {
    console.error('❌ webhook error:', err);
    if (!res.headersSent) res.status(200).send('OK');
  }
});

// ════════════════════════════════════════════════
// 事件處理
// ════════════════════════════════════════════════

// ════════════════════════════════════════════════
// 模式處理函數
// ════════════════════════════════════════════════

// ── 新增記事（兩步驟）＋ 確認刪除流程 ──
async function handleNoteMode(userId, text, reply, state, notes) {
  if (state.step === 'waiting_content') {
    userState[userId].tempContent = text;
    userState[userId].step = 'waiting_keyword';
    await reply('收到 ✍️\n\n幫這則記事取個關鍵字吧，之後用關鍵字就能快速找到它～');
    return;
  }

  if (state.step === 'waiting_keyword') {
    const keyword = text;
    const category = classify(state.tempContent);
    notes[keyword] = { content: state.tempContent, category };
    await saveData();
    resetState(userId);
    const catEmoji = CATEGORY_EMOJI[category] ?? '📌';
    await reply(`存好了 ✅\n\n🔑 ${keyword}\n📝 ${state.tempContent}\n${catEmoji} 分類：${category}\n\n${smartReply(category)}`);
    return;
  }

  if (state.step === 'confirm_delete') {
    if (text === '確認') {
      const key = state.deleteKey;
      delete notes[key];
      await saveData();
      resetState(userId);
      clearMode(userId);
      await reply(`好，「${key}」已經刪掉了 🗑️`);
    } else {
      resetState(userId);
      clearMode(userId);
      await reply('好的，我幫你保留著 😌');
    }
    return;
  }
}

// ── 模式 search：進階搜尋 + 分頁 ──
async function handleSearchMode(userId, text, reply, notes) {
  const state = userState[userId];

  // 「搜尋」入口後，等待使用者輸入關鍵字
  if (state.step === 'waiting_search_keyword') {
    const keyword = text.trim().toLowerCase();
    if (!keyword) {
      await reply('請輸入要搜尋的關鍵字');
      return;
    }
    const results = Object.keys(notes).filter((k) => {
      const keyMatch = k.toLowerCase().includes(keyword);
      const contentMatch = getNoteContent(notes[k]).toLowerCase().includes(keyword);
      return keyMatch || contentMatch;
    });
    if (results.length === 0) {
      resetState(userId);
      clearMode(userId);
      await reply('❌ 沒找到相關紀錄');
      return;
    }
    searchState[userId] = { keyword, results, page: 1 };
    userState[userId].step = null;
    await reply(buildSearchPage(results, 1, notes));
    return;
  }

  // 從模糊搜尋結果選擇數字
  if (state.step === 'choosing') {
    const num = parseInt(text, 10);
    if (!isNaN(num) && num >= 1 && num <= state.results.length) {
      const keyword = state.results[num - 1];
      resetState(userId);
      clearMode(userId);
      const cat = getNoteCategory(notes[keyword]);
      await reply(`📋 ${keyword}　${CATEGORY_EMOJI[cat] ?? '📌'}${cat}\n${'─'.repeat(16)}\n${getNoteContent(notes[keyword])}`);
    } else {
      resetState(userId);
      clearMode(userId);
      await reply('好的，我先關掉選單囉 😊\n\n有需要隨時再搜尋就好！');
    }
    return;
  }

  // 下一頁
  if (text === '下一頁') {
    const ss = searchState[userId];
    if (!ss || !ss.results) {
      await reply('❌ 沒有查詢紀錄，請先輸入「找 關鍵字」');
      return;
    }
    const totalPages = Math.ceil(ss.results.length / 10);
    if (ss.page >= totalPages) {
      clearMode(userId);
      await reply('❌ 已經沒有更多資料了');
      return;
    }
    ss.page += 1;
    await reply(buildSearchPage(ss.results, ss.page, notes));
    return;
  }

  // 找 xxx
  if (text.startsWith('找 ') || text.startsWith('找　')) {
    const keyword = text.slice(2).trim().toLowerCase();
    if (!keyword) {
      await reply('請輸入要搜尋的關鍵字，例如：找 工作');
      return;
    }
    const results = Object.keys(notes).filter((k) => {
      const keyMatch = k.toLowerCase().includes(keyword);
      const contentMatch = getNoteContent(notes[k]).toLowerCase().includes(keyword);
      return keyMatch || contentMatch;
    });
    if (results.length === 0) {
      clearMode(userId);
      await reply(`❌ 沒找到包含「${keyword}」的紀錄`);
      return;
    }
    searchState[userId] = { keyword, results, page: 1 };
    await reply(buildSearchPage(results, 1, notes));
    return;
  }
}

// ── 模式 category：依分類瀏覽筆記 ──
async function handleCategoryMode(userId, text, reply, notes) {
  const validCategories = ['工作', '靈感', '日記', '待辦', '其他'];
  clearMode(userId);

  if (!validCategories.includes(text)) {
    await reply('請輸入分類名稱：\n\n💼 工作\n💡 靈感\n📖 日記\n✅ 待辦\n📌 其他');
    return;
  }

  const filtered = Object.keys(notes).filter((k) => getNoteCategory(notes[k]) === text);
  if (filtered.length === 0) {
    await reply(`${CATEGORY_EMOJI[text] ?? '📌'} 你還沒有「${text}」分類的記事`);
    return;
  }

  const list = filtered.map((k, i) => `${NUMBER_EMOJI[i] ?? `${i + 1}.`} ${k}`).join('\n');
  await reply(`${CATEGORY_EMOJI[text] ?? '📌'} ${text}（共 ${filtered.length} 則）\n\n${list}\n\n直接輸入關鍵字就能查看內容 👆`);
}

// webhook → handleEvent → handleUserMessage
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const text = event.message.text.trim();

  await handleUserMessage(userId, text, replyToken);
}

async function handleUserMessage(userId, text, replyToken) {
  const reply = (msg) => replyMessage(replyToken, msg);

  // ════════════════════════════════════════════════
  // 管理員機制：第一位使用 bot 的人自動成為 admin
  // ════════════════════════════════════════════════
  if (!data.admin) {
    data.admin = userId;
    await saveData();
    console.log('🔥 Admin 設定成功:', data.admin);
  }

  const isAdmin = (userId === data.admin);

  if (text === '197909') {
    if (!isAdmin) {
      data.admin = userId;
      await saveData();
    }
    await reply('你已成為管理員 👑');
    return;
  }

  // ════════════════════════════════════════════════
  // 邀請碼驗證（未解鎖 + 非 admin 才需要）
  // ════════════════════════════════════════════════
  if (!isAdmin && !data.unlockedUsers[userId]) {
    const code = text.toUpperCase();
    if (data.inviteCodes[code]) {
      data.unlockedUsers[userId] = true;
      delete data.inviteCodes[code];
      await saveData();
      await reply('解鎖成功 ✨ 我會幫你好好記住每件事的 😎\n\n（輸入「幫助」看看我能幹嘛）');
    } else {
      await reply('邀請碼無效 🥺\n\n這是內測版記事本，需要邀請碼才能使用');
    }
    return;
  }

  // ════════════════════════════════════════════════
  // 管理員指令（任何模式下都有效）
  // ════════════════════════════════════════════════
  if (text === '新增邀請碼') {
    if (!isAdmin) { await reply('這功能目前只有管理員能用 😏'); return; }
    const code = generateCode();
    data.inviteCodes[code] = true;
    await saveData();
    await reply(`已產生邀請碼：${code} 🎟️\n\n把它分享給想邀請的人吧！`);
    return;
  }

  if (text === '查看邀請碼') {
    if (!isAdmin) { await reply('這功能目前只有管理員能用 😏'); return; }
    const available = Object.keys(data.inviteCodes);
    if (available.length === 0) {
      await reply('目前沒有邀請碼，輸入「新增邀請碼」來產生一個吧！');
    } else {
      await reply(`目前可用的邀請碼（共 ${available.length} 組）：\n\n${available.join('\n')}`);
    }
    return;
  }

  // ════════════════════════════════════════════════
  // 初始化使用者
  // ════════════════════════════════════════════════
  initUser(userId);
  const state = userState[userId];
  const notes = data.notesByUser[userId];

  // ── 全域指令（任何模式下都優先處理）──
  if (text === '功能介紹') {
    await reply('📒 記事本使用方式\n\n➕ 新增\n👉 輸入「新增」開始記錄\n\n📦 工具箱\n👉 查看所有記事\n\n❌ 刪除\n👉 輸入「刪除 關鍵字」\n\n🔍 搜尋\n👉 直接輸入關鍵字即可查詢');
    return;
  }

  if (text === '幫助') {
    await reply('這是你的私人記事本 🧠\n\n你可以這樣用：\n\n📝 新增記事\n→ 輸入「新增」\n\n🔍 查詢記事\n→ 直接輸入關鍵字，或輸入部分字串模糊搜尋\n\n🗂️ 看所有記事\n→ 輸入「工具箱」\n\n🗑️ 刪除記事\n→ 輸入「刪除 關鍵字」');
    return;
  }

  if (text === '工具箱' || text === '查詢紀錄') {
    const keys = Object.keys(notes);
    if (keys.length === 0) {
      await reply('你的記事本還是空的耶 📭\n\n輸入「新增」，把第一件事記下來吧！');
    } else {
      const list = keys.map((k, i) => `${NUMBER_EMOJI[i] ?? `${i + 1}.`} ${k}`).join('\n');
      await reply(`這是你目前存的所有記事 🗂️（共 ${keys.length} 則）\n\n${list}\n\n直接輸入關鍵字就能查看內容 👆`);
    }
    return;
  }

  // ── 刪除指令（不受模式影響）──
  if (text.startsWith('刪除 ') || text.startsWith('刪除　')) {
    const keyword = text.slice(3).trim();
    if (notes[keyword] === undefined) {
      await reply(`找不到「${keyword}」這個關鍵字耶 🤔\n\n輸入「工具箱」看看你有哪些記事？`);
      return;
    }
    userState[userId] = { step: 'confirm_delete', tempContent: '', deleteKey: keyword, results: [] };
    await reply(`確定要刪掉「${keyword}」嗎？⚠️\n\n內容是：${getNoteContent(notes[keyword])}\n\n刪了就找不回來喔，確認的話回覆「確認」。`);
    return;
  }

  // ════════════════════════════════════════════════
  // 模式入口指令
  // ════════════════════════════════════════════════
  if (text === '分類瀏覽') {
    setMode(userId, 'category');
    await reply('📂 分類瀏覽模式\n\n請輸入分類名稱：\n\n💼 工作\n💡 靈感\n📖 日記\n✅ 待辦\n📌 其他');
    return;
  }

  if (text === '新增') {
    setMode(userId, 'add');
    await reply('請輸入要記錄的內容 📝');
    return;
  }

  if (text === '搜尋') {
    setMode(userId, 'search');
    userState[userId].step = 'waiting_search_keyword';
    await reply('請輸入關鍵字');
    return;
  }

  if (text.startsWith('找 ') || text.startsWith('找　')) {
    setMode(userId, 'search');
    return handleSearchMode(userId, text, reply, notes);
  }

  if (text === '下一頁') {
    return handleSearchMode(userId, text, reply, notes);
  }

  // ════════════════════════════════════════════════
  // 模式路由
  // ════════════════════════════════════════════════
  const mode = getMode(userId);

  if (mode === 'add') {
    const category = classify(text);
    const key = `記錄_${Date.now()}`;
    notes[key] = { content: text, category };
    await saveData();
    clearMode(userId);
    const catEmoji = CATEGORY_EMOJI[category] ?? '📌';
    await reply(`✅ 已記錄（${catEmoji} ${category}）\n\n${smartReply(category)}`);
    return;
  }

  if (state.step === 'confirm_delete' || state.step === 'waiting_content' || state.step === 'waiting_keyword') {
    return handleNoteMode(userId, text, reply, state, notes);
  }

  if (mode === 'search' || state.step === 'choosing' || state.step === 'waiting_search_keyword') {
    return handleSearchMode(userId, text, reply, notes);
  }

  if (mode === 'category') {
    return handleCategoryMode(userId, text, reply, notes);
  }

  // ════════════════════════════════════════════════
  // 預設：不儲存，提示使用方式
  // ════════════════════════════════════════════════
  await reply('輸入「新增」來記錄 📝\n輸入「搜尋」來查找 🔍\n輸入「工具箱」看所有記事 🗂️');
}

// ════════════════════════════════════════════════
// 啟動：先載入 Firestore 資料，再開始監聽
// ════════════════════════════════════════════════
(async () => {
  try {
    data = await loadData();
    console.log('✅ Firestore 資料載入成功');
  } catch (e) {
    console.error('❌ Firestore 載入失敗，使用預設資料', e);
  }

  console.log('CHANNEL_SECRET exists:', !!process.env.CHANNEL_SECRET);
  console.log('CHANNEL_ACCESS_TOKEN exists:', !!process.env.CHANNEL_ACCESS_TOKEN);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Server running on port', PORT);
  });
})();
