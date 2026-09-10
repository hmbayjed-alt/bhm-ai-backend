// BHM AI — Backend Server
// এই সার্ভারটি ব্রাউজার থেকে API key লুকিয়ে রেখে নিরাপদে Google Gemini API-তে রিকোয়েস্ট পাঠায়।
// Gemini API ব্যবহার করা হয়েছে কারণ এর একটি স্থায়ী ফ্রি টায়ার আছে (ক্রেডিট কার্ড ছাড়াই)।

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { convertBijoyToUnicode, shouldConvertAsBijoy } = require('bijoy2unicode');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || 'gemini-3.6-flash';

if (!API_KEY) {
  console.error('❌ GEMINI_API_KEY পাওয়া যায়নি। .env ফাইলে সেটা সেট করুন (দেখুন .env.example)।');
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// একই IP থেকে অতিরিক্ত রিকোয়েস্ট ঠেকাতে rate limiting
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // ১ মিনিট
  max: 20,             // প্রতি মিনিটে সর্বোচ্চ ২০টি রিকোয়েস্ট প্রতি IP থেকে
  message: { error: 'একটু ধীরে! কিছুক্ষণ পর আবার চেষ্টা করুন।' }
});

const SYSTEM_PROMPT = `তুমি "BHM AI" (বি এইচ এম এ আই) — একটি সর্ববিষয়ভিত্তিক AI Assistant।

নিয়মাবলী:
- সবসময় সহজ, সুন্দর, বোধগম্য ভাষায় উত্তর দাও। ব্যবহারকারী যে ভাষায় লেখে, সেই ভাষায় উত্তর দাও (ডিফল্ট বাংলা)।
- বিষয়ভিত্তিক পরিসর: শিক্ষা, কুরআন, হাদিস, তাফসীর, ইজমা, কিয়াস, বিজ্ঞান, প্রযুক্তি, কৃষি, ইতিহাস, ভূগোল, সাধারণ জ্ঞান, গণিত, প্রোগ্রামিং, ব্যবসা, স্বাস্থ্য, খেলাধুলা, বিনোদন, YouTube, AI, মোবাইল, কম্পিউটার এবং যেকোনো সাধারণ প্রশ্ন।
- প্রয়োজনে ধাপে ধাপে ব্যাখ্যা করো, উদাহরণ দাও।
- ইসলামিক বিষয়ে (কুরআন/হাদিস/তাফসীর/ফিকহ) উত্তর দেওয়ার সময় সতর্ক ও যত্নশীল থাকো; নিশ্চিত না হলে স্পষ্টভাবে বলো যে একজন আলেমের কাছ থেকে যাচাই করে নেওয়া ভালো, এবং কখনো নিজে থেকে ফতোয়া দিও না।
- স্বাস্থ্য/আইনি বিষয়ে সাধারণ তথ্য দাও, কিন্তু বলে দাও যে বিশেষজ্ঞের পরামর্শ নেওয়া উচিত।
- টোন হবে বন্ধুত্বপূর্ণ, আধুনিক এবং শ্রদ্ধাশীল।
- সবসময় প্লেইন টেক্সট লিখবে — কোনো মার্কডাউন ফরম্যাটিং (যেমন **, #, ---, ব্যাকটিক) ব্যবহার করবে না, কারণ চ্যাট বক্সে এগুলো হুবহু চিহ্ন হিসেবে দেখা যায়। জোর দিতে চাইলে শুধু সাধারণ বাক্য গঠন বা লাইন ব্রেক ব্যবহার করো।
- কেউ যদি জিজ্ঞেস করে "তোমাকে কে তৈরি করেছে", "তোমার নির্মাতা কে", "who made you", "who created you" — বা এই ধরনের যেকোনো প্রশ্ন করে, তাহলে ঠিক এই উত্তরটি দাও (আর কিছু যোগ না করে বা ব্যাখ্যা না করে):
"আমাকে BHM Media YouTube Channel-এর পরিচালক তৈরি করেছেন।"
`;

// এই মডেলগুলো ছবি/PDF-এর মতো সরাসরি Gemini-কে পাঠানো যায় (inlineData হিসেবে)
const NATIVE_MIME_TYPES = new Set(['application/pdf']);
function isNativeType(mimeType){
  return mimeType.startsWith('image/') || NATIVE_MIME_TYPES.has(mimeType);
}

const MAX_EXTRACTED_CHARS = 6000;

// docx/xlsx/xls/csv/txt ফাইল থেকে লেখা বের করে; না পারলে null রিটার্ন করে
async function extractTextFromDocument(mimeType, buffer, fileName){
  try{
    let text = null;
    if(mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(fileName || '')){
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    }
    else if(
      mimeType === 'application/vnd.ms-excel' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      /\.(xlsx|xls)$/i.test(fileName || '')
    ){
      const wb = XLSX.read(buffer, { type: 'buffer' });
      let t = '';
      wb.SheetNames.forEach((name) => {
        t += `\n--- শীট: ${name} ---\n` + XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      });
      text = t;
    }
    else if(mimeType === 'text/plain' || mimeType === 'text/csv' || /\.(txt|csv)$/i.test(fileName || '')){
      text = buffer.toString('utf-8');
    }

    if(text === null) return null; // অসমর্থিত ফরম্যাট (যেমন পুরনো .doc, .ppt)

    // পুরনো "বিজয়"/SutonnyMJ ফন্টে লেখা টেক্সট হলে সেটাকে আসল ইউনিকোড বাংলায় রূপান্তর করা হয়
    if(shouldConvertAsBijoy(text)){
      text = convertBijoyToUnicode(text);
    }
    return text;
  }catch(err){
    console.error('Document extraction error:', err);
    return null;
  }
}

// health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'BHM AI backend' });
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { messages, image: file } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages অ্যারে দরকার।' });
    }

    // মেসেজ হিস্টোরি অতিরিক্ত বড় হলে সার্ভার/API খরচ (ও ফ্রি-টায়ার কোটা) বাঁচাতে সীমিত রাখা
    const trimmed = messages.slice(-20);

    // সংযুক্ত ফাইল থাকলে সেটা কীভাবে ব্যবহার হবে আগেভাগে ঠিক করে নেওয়া হয়
    let extractedDocText = null;
    let unsupportedFile = false;
    if (file && file.data && file.mimeType && !isNativeType(file.mimeType)) {
      const buffer = Buffer.from(file.data, 'base64');
      extractedDocText = await extractTextFromDocument(file.mimeType, buffer, file.name);
      if (extractedDocText === null) unsupportedFile = true;
      else if (extractedDocText.length > MAX_EXTRACTED_CHARS) {
        extractedDocText = extractedDocText.slice(0, MAX_EXTRACTED_CHARS) + '\n...(বাকি অংশ ছেঁটে ফেলা হয়েছে)';
      }
    }

    // আমাদের {role:'user'|'assistant', content:'...'} ফরম্যাটকে Gemini-র
    // {role:'user'|'model', parts:[{text}]} ফরম্যাটে রূপান্তর
    const contents = trimmed.map((m, idx) => {
      const isLast = idx === trimmed.length - 1;
      let text = m.content;
      if (isLast && extractedDocText) {
        text = `[সংযুক্ত ফাইল "${file.name || 'document'}" থেকে নেওয়া লেখা]\n${extractedDocText}\n\n[ব্যবহারকারীর প্রশ্ন]\n${m.content}`;
      }
      if (isLast && unsupportedFile) {
        text = `${m.content}\n\n(নোট: "${file.name || 'ফাইলটি'}" এই ফরম্যাটটি এই মুহূর্তে সাপোর্ট করা হয় না — শুধু ছবি, PDF, Word (.docx), Excel (.xls/.xlsx), .csv ও .txt ফাইল পড়া যায়। ব্যবহারকারীকে বিনয়ের সাথে এটা জানাও।)`;
      }
      const parts = [{ text }];
      if (isLast && file && file.data && file.mimeType && isNativeType(file.mimeType)) {
        parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts
      };
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
    const requestBody = JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { maxOutputTokens: 1000 }
    });

    // সাময়িক (503) ত্রুটি হলে কয়েক সেকেন্ড অপেক্ষা করে স্বয়ংক্রিয়ভাবে আবার চেষ্টা করা হয়
    const MAX_ATTEMPTS = 3;
    let response;
    let lastErrText = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });

      if (response.ok) break;

      lastErrText = await response.text();
      const isRetryable = response.status === 503 && attempt < MAX_ATTEMPTS;
      if (!isRetryable) break;

      const waitMs = attempt * 1500; // ১.৫s, ৩s ...
      console.log(`Gemini 503 — attempt ${attempt} ব্যর্থ, ${waitMs}ms পর আবার চেষ্টা হবে`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    if (!response.ok) {
      console.error('Gemini API error:', response.status, lastErrText);
      if (response.status === 429) {
        return res.status(429).json({ error: 'ফ্রি টায়ারের সীমা শেষ — কিছুক্ষণ পর আবার চেষ্টা করুন।' });
      }
      if (response.status === 503) {
        return res.status(503).json({ error: 'AI মডেলটি এই মুহূর্তে ব্যস্ত আছে (অনেক ব্যবহারকারীর চাপে) — আমরা কয়েকবার চেষ্টা করেছি, একটু পর আবার চেষ্টা করুন।' });
      }
      return res.status(502).json({ error: 'AI সার্ভিস থেকে উত্তর পাওয়া যায়নি।' });
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const reply = parts.map((p) => p.text || '').join('\n').trim()
      || 'দুঃখিত, উত্তর তৈরি করা যায়নি। আবার চেষ্টা করুন।';

    res.json({ reply });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'সার্ভারে একটি সমস্যা হয়েছে।' });
  }
});

const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-2.5-flash-image';

app.post('/api/generate-image', chatLimiter, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt দরকার।' });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${API_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini image API error:', response.status, errText);
      if (response.status === 429) {
        return res.status(429).json({ error: 'ছবি বানানোর ফ্রি সীমা আজকের মতো শেষ — কিছুক্ষণ পর আবার চেষ্টা করুন।' });
      }
      return res.status(502).json({ error: 'ছবি বানানো যায়নি, আবার চেষ্টা করুন।' });
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p.inlineData && p.inlineData.data);
    const textPart = parts.find((p) => p.text);

    if (!imagePart) {
      return res.status(502).json({ error: 'ছবি বানানো যায়নি, প্রম্পটটা আরেকভাবে লিখে চেষ্টা করুন।' });
    }

    res.json({
      image: { mimeType: imagePart.inlineData.mimeType, data: imagePart.inlineData.data },
      caption: textPart ? textPart.text : ''
    });
  } catch (err) {
    console.error('Image generation server error:', err);
    res.status(500).json({ error: 'সার্ভারে একটি সমস্যা হয়েছে।' });
  }
});

app.post('/api/enhance-prompt', chatLimiter, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt দরকার।' });
    }

    const instruction = `Translate and expand the following image description (which may be in Bengali or any language) into a single, vivid, detailed English image-generation prompt suitable for an AI image generator. Reply with ONLY the English prompt text — no quotes, no labels, no extra commentary.\n\nDescription: ${prompt}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: instruction }] }],
        generationConfig: { maxOutputTokens: 200 }
      })
    });

    if (!response.ok) {
      // ব্যর্থ হলে মূল প্রম্পটটাই ফিরিয়ে দেওয়া হয়, যাতে ছবি বানানো একেবারে থেমে না যায়
      return res.json({ prompt });
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const enhanced = parts.map((p) => p.text || '').join(' ').trim();

    res.json({ prompt: enhanced || prompt });
  } catch (err) {
    console.error('Enhance prompt error:', err);
    res.json({ prompt: req.body?.prompt || '' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ BHM AI backend চলছে: http://localhost:${PORT}`);
});
