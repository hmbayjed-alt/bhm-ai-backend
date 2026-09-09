// BHM AI — Backend Server (Retry + Cache সহ আপডেট)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || 'gemini-2.0-flash';

if (!API_KEY) {
  console.error('❌ GEMINI_API_KEY পাওয়া যায়নি।');
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ CACHE — একই প্রশ্নে বারবার API call বন্ধ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const responseCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // ১ ঘন্টা cache

function getCacheKey(messages) {
  // শেষ ৩টি message দিয়ে cache key বানাই
  const last = messages.slice(-3);
  return JSON.stringify(last);
}

function getFromCache(key) {
  const item = responseCache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL) {
    responseCache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value) {
  responseCache.set(key, { value, time: Date.now() });
  // Cache বেশি বড় হলে পুরানোগুলো মুছে ফেলা
  if (responseCache.size > 200) {
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ RETRY LOGIC — 429 error হলে আবার চেষ্টা
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function callGeminiWithRetry(contents, maxRetries = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Attempt ${attempt}/${maxRetries}...`);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          generationConfig: { maxOutputTokens: 1000 }
        })
      });

      // ✅ সফল হলে return করো
      if (response.ok) {
        const data = await response.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const reply = parts.map((p) => p.text || '').join('\n').trim()
          || 'দুঃখিত, উত্তর তৈরি করা যায়নি। আবার চেষ্টা করুন।';
        console.log(`✅ Attempt ${attempt} সফল!`);
        return { success: true, reply };
      }

      // ❌ 429 = quota শেষ → অপেক্ষা করে retry
      if (response.status === 429) {
        const waitSeconds = attempt * 30; // ৩০, ৬০, ৯০ সেকেন্ড
        console.log(`⏳ 429 Rate limit! ${waitSeconds} সেকেন্ড অপেক্ষা করছি... (attempt ${attempt}/${maxRetries})`);

        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, waitSeconds * 1000));
          continue; // আবার চেষ্টা
        } else {
          // সব retry শেষ
          return { success: false, status: 429, error: 'ফ্রি টায়ারের সীমা শেষ — কিছুক্ষণ পর আবার চেষ্টা করুন।' };
        }
      }

      // অন্য error
      const errText = await response.text();
      console.error(`❌ API Error ${response.status}:`, errText);
      return { success: false, status: response.status, error: 'AI সার্ভিস থেকে উত্তর পাওয়া যায়নি।' };

    } catch (err) {
      console.error(`❌ Network error attempt ${attempt}:`, err.message);
      if (attempt < maxRetries) {
        console.log(`🔄 ১৫ সেকেন্ড পরে আবার চেষ্টা...`);
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
      return { success: false, status: 500, error: 'নেটওয়ার্ক সমস্যা হয়েছে।' };
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rate Limiter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'একটু ধীরে! কিছুক্ষণ পর আবার চেষ্টা করুন।' }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// System Prompt
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const SYSTEM_PROMPT = `তুমি "BHM AI" (বি এইচ এম এ আই) — একটি সর্ববিষয়ভিত্তিক AI Assistant।

নিয়মাবলী:
- সবসময় সহজ, সুন্দর, বোধগম্য ভাষায় উত্তর দাও। ব্যবহারকারী যে ভাষায় লেখে, সেই ভাষায় উত্তর দাও (ডিফল্ট বাংলা)।
- বিষয়ভিত্তিক পরিসর: শিক্ষা, কুরআন, হাদিস, তাফসীর, ইজমা, কিয়াস, বিজ্ঞান, প্রযুক্তি, কৃষি, ইতিহাস, ভূগোল, সাধারণ জ্ঞান, গণিত, প্রোগ্রামিং, ব্যবসা, স্বাস্থ্য, খেলাধুলা, বিনোদন, YouTube, AI, মোবাইল, কম্পিউটার এবং যেকোনো সাধারণ প্রশ্ন।
- প্রয়োজনে ধাপে ধাপে ব্যাখ্যা করো, উদাহরণ দাও।
- ইসলামিক বিষয়ে (কুরআন/হাদিস/তাফসীর/ফিকহ) উত্তর দেওয়ার সময় সতর্ক ও যত্নশীল থাকো।
- স্বাস্থ্য/আইনি বিষয়ে সাধারণ তথ্য দাও, কিন্তু বিশেষজ্ঞের পরামর্শ নিতে বলো।
- টোন হবে বন্ধুত্বপূর্ণ, আধুনিক এবং শ্রদ্ধাশীল।
- সবসময় প্লেইন টেক্সট লিখবে — কোনো মার্কডাউন ফরম্যাটিং ব্যবহার করবে না।
- কেউ যদি জিজ্ঞেস করে "তোমাকে কে তৈরি করেছে" বা এই ধরনের প্রশ্ন করে, উত্তর দাও:
"আমাকে BHM Media YouTube Channel-এর পরিচালক তৈরি করেছেন।"
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'BHM AI backend', cacheSize: responseCache.size });
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { messages, image } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages অ্যারে দরকার।' });
    }

    const trimmed = messages.slice(-20);

    // ✅ Cache চেক করো
    const cacheKey = getCacheKey(trimmed);
    const cached = getFromCache(cacheKey);
    if (cached) {
      console.log('⚡ Cache থেকে উত্তর দিচ্ছি');
      return res.json({ reply: cached });
    }

    // Gemini format এ convert করো
    const contents = trimmed.map((m, idx) => {
      const parts = [{ text: m.content }];
      const isLast = idx === trimmed.length - 1;
      if (isLast && image && image.data && image.mimeType) {
        parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts
      };
    });

    // ✅ Retry Logic সহ Gemini call
    const result = await callGeminiWithRetry(contents);

    if (!result.success) {
      return res.status(result.status || 500).json({ error: result.error });
    }

    // ✅ Cache এ save করো
    setCache(cacheKey, result.reply);

    res.json({ reply: result.reply });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'সার্ভারে একটি সমস্যা হয়েছে।' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ BHM AI backend চলছে: http://localhost:${PORT}`);
  console.log(`📦 Model: ${MODEL}`);
  console.log(`✅ Retry Logic: চালু (সর্বোচ্চ ৩ বার)`);
  console.log(`⚡ Cache: চালু (১ ঘন্টা)`);
});
