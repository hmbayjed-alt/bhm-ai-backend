// BHM AI — Backend Server
// এই সার্ভারটি ব্রাউজার থেকে API key লুকিয়ে রেখে নিরাপদে Google Gemini API-তে রিকোয়েস্ট পাঠায়।
// Gemini API ব্যবহার করা হয়েছে কারণ এর একটি স্থায়ী ফ্রি টায়ার আছে (ক্রেডিট কার্ড ছাড়াই)।

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

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
- কেউ যদি জিজ্ঞেস করে "তোমাকে কে তৈরি করেছে", "তোমার নির্মাতা কে", "who made you", "who created you" — বা এই ধরনের যেকোনো প্রশ্ন করে, তাহলে ঠিক এই উত্তরটি দাও (আর কিছু যোগ না করে বা ব্যাখ্যা না করে):
"আমাকে BHM Media YouTube Channel-এর পরিচালক তৈরি করেছেন।"
`;

// health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'BHM AI backend' });
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { messages, image } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages অ্যারে দরকার।' });
    }

    // মেসেজ হিস্টোরি অতিরিক্ত বড় হলে সার্ভার/API খরচ (ও ফ্রি-টায়ার কোটা) বাঁচাতে সীমিত রাখা
    const trimmed = messages.slice(-20);

    // আমাদের {role:'user'|'assistant', content:'...'} ফরম্যাটকে Gemini-র
    // {role:'user'|'model', parts:[{text}]} ফরম্যাটে রূপান্তর
