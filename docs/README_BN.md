# ZombieCoder এজেন্ট মডিউল - সহজ বাংলা গাইড

## এটি কী?
এটি একটি AI এজেন্ট সিস্টেম যা আপনার প্রজেক্টের সাথে খুব সহজেই যুক্ত করা যায়। এটি ৫টি ভিন্ন ভিন্ন কাজের জন্য তৈরি করা হয়েছে।

## কিভাবে ব্যবহার করবেন?

### ধাপ ১: ইনস্টল করুন
```bash
npm install zombiecoder-agent-module
```

### ধাপ ২: কোডে যুক্ত করুন
```typescript
import { createZombieCoderAgent } from 'zombiecoder-agent-module';

const agent = createZombieCoderAgent({
  userId: 'user-123',
  conversationId: 'conv-456',
});
```

### ধাপ ৩: ব্যবহার করুন
```typescript
// কোড লেখার জন্য
const result = await agent.executeTask('development-engineer', 'একটি ফাংশন লিখুন...');

// আর্কিটেকচার ডিজাইনের জন্য
const arch = await agent.executeTask('solution-architect', 'সিস্টেম ডিজাইন করুন...');
```

## ৫টি এজেন্ট

1. **Solution Architect** - সিস্টেম ডিজাইন করে
2. **Development Engineer** - কোড লেখে এবং ঠিক করে
3. **Quality Assurance** - টেস্ট করে এবং ভুল খুঁজে বের করে
4. **Documentation** - ডকুমেন্ট লেখে
5. **Operations** - সার্ভার চালানো এবং মনিটর করে

## মডেল
- **ফ্রি মডেল**: OpenCode Zen থেকে নেওয়া হয়
- **ব্যাকআপ**: আপনার কম্পিউটারে Ollama বা Google Gemini

## সেটিংস
`.env` ফাইলে এই লাইনগুলো যোগ করুন:
```
UNIVERSAL_LLM_BASE=http://localhost:11434/v1
UNIVERSAL_LLM_KEY=your-api-key
UNIVERSAL_LLM_MODEL=qwen2.5-coder:7b
```

## পরিচয়
এই সিস্টেমটির মালিক Sahon Srabon, Developer Zone, ঢাকা, বাংলাদেশ।
যেকোনো প্রশ্নে: infi@zombiecoder.my.id বা +880 1323-626282

## ওয়েবসাইট
https://zombiecoder.my.id/
