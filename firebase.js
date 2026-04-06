require('dotenv').config();

const admin = require('firebase-admin');

// 🔥 Debug（確認 env 有沒有讀到）
console.log("🔥 FIREBASE KEY EXISTS:", !!process.env.FIREBASE_PRIVATE_KEY_BASE64);

// ✅ 從 base64 還原 JSON
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8')
);

// ✅ 避免重複初始化（Render 很重要）
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

module.exports = db;