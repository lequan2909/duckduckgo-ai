import { Hono } from 'hono';
import { z } from "zod";
import { validator } from "hono/validator";
import { OpenAIRequest, OpenAIResponse } from "./types";
import { streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';
import { createHash } from 'crypto'; // Thêm import cho crypto

const headers = {
  'Content-Type': 'application/json',
  'User-Agent': 'DuckDuckGo/1.0',
  'Accept': 'application/json',
};

const statusURL = "https://duckduckgo.com/duckchat/v1/status";
const chatURL = "https://duckduckgo.com/duckchat/v1/chat";

const schema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string()
  })),
  stream: z.boolean().optional()
});

const models = [
  { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
  { id: "gpt-4", name: "GPT-4" },
];

const app = new Hono();

app.use('/*', cors({
  origin: "*",
}));

const getXvqd4 = async function () {
  const res = await fetch(statusURL, {
    method: "GET",
    headers: headers,
  });
  return res.headers.get("x-vqd-4");
};

// Hàm để lưu trữ và lấy x-vqd-4 từ Cloudflare KV
const getOrSetXvqd4 = async (conversationHash: string, newValue?: string) => {
  if (newValue) {
    // Lưu giá trị mới vào KV
    await KV.put(conversationHash, newValue);
    return newValue;
  }
  // Lấy giá trị từ KV
  return await KV.get(conversationHash);
};

const createConversationHash = (messages: Array<{ role: string; content: string }>): string => {
  const hash = createHash('sha256');
  messages.forEach(message => {
    hash.update(`${message.role}:${message.content}`);
  });
  return hash.digest('hex');
};

app.get('/', (c) => {
  return c.text('Hello Hono!');
});

app.get("/v1/models", (c) => {
  return c.json(models);
});

app.post("/v1/chat/completions", validator('json', (value, c) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0].message }, 400);
  }
  return parsed.data;
}), async (c) => {
  const apikey = c.env["apikey"] ?? '';
  if (apikey) {
    const authorization = c.req.header("Authorization");
    if (!authorization) {
      return c.json({ "error": "authorization error" }, 401);
    }
    if (apikey !== authorization.substring(7)) {
      return c.json({ "error": "apikey error" }, 401);
    }
  }

  const params = await c.req.json<OpenAIRequest>();
  const requestParams = {
    "model": params.model,
    "messages": []
  };
  const messages = [];
  for (let message of params.messages) {
    if (message.role === 'system') {
      messages.push({ "role": "user", "content": message.content });
    } else {
      messages.push(message);
    }
  }
  requestParams["messages"] = messages;

  try {
    const conversationHash = createConversationHash(params.messages); // Tạo hash cho cuộc hội thoại
    let x4 = await getOrSetXvqd4(conversationHash);
    if (!x4) {
      x4 = await getXvqd4() || "";
      if (!x4) {
        return c.json({ error: "x-vqd-4 get error" }, 400);
      }
      await getOrSetXvqd4(conversationHash, x4); // Lưu x-vqd-4 vào KV
    }

    const resp = await fetch(chatURL, {
      method: "POST",
      headers: { "x-vqd-4": x4, ...headers },
      body: JSON.stringify(requestParams)
    });

    if (!resp.ok) {
      return c.json({ "error": "api request error", "message": await resp.text() }, 400);
    }
    c.header("x-vqd-4", resp.headers.get("x-vqd-4") || "");
    
    const responseData: OpenAIResponse = await resp.json();
    return c.json(responseData);
  } catch (e) {
    return c.json({ error: e.message || e }, 400);
  }
});

export default app;
