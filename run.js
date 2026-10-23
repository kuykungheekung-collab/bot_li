'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const PORT = Number(process.env.PORT || 3000);
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ADMIN_LINE_TARGET = process.env.ADMIN_LINE_TARGET;
const MAX_BODY_BYTES = 1024 * 1024;

function missingConfiguration() {
  const missing = [];
  if (!CHANNEL_SECRET) missing.push('LINE_CHANNEL_SECRET');
  if (!CHANNEL_ACCESS_TOKEN) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  if (!ADMIN_LINE_TARGET) missing.push('ADMIN_LINE_TARGET');
  return missing;
}

function verifySignature(body, signature) {
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', CHANNEL_SECRET)
    .update(body)
    .digest();

  let received;
  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  return received.length === expected.length
    && crypto.timingSafeEqual(received, expected);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function lineApi(path, payload) {
  const response = await fetch(`https://api.line.me/v2/bot/message/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`LINE ${path} API returned ${response.status}: ${details}`);
  }
}

function automaticReply(text) {
  const message = text.trim().toLowerCase();

  if (['สวัสดี', 'ดีครับ', 'ดีค่ะ', 'hello', 'hi']
    .some((greeting) => message.startsWith(greeting))) {
    return 'สวัสดีค่ะ ขอบคุณที่ติดต่อเรา แจ้งสิ่งที่ต้องการสอบถามได้เลยนะคะ';
  }

  if (message.includes('เวลาเปิด') || message.includes('เวลาทำการ')) {
    return 'ขอบคุณที่สอบถามค่ะ แอดมินจะช่วยแจ้งเวลาทำการให้ทราบโดยเร็วที่สุดนะคะ';
  }

  if (message.includes('ราคา') || message.includes('ค่าบริการ')) {
    return 'ขอบคุณที่สอบถามเรื่องราคาค่ะ แอดมินจะติดต่อกลับพร้อมรายละเอียดนะคะ';
  }

  return 'ได้รับข้อความแล้วค่ะ ขอบคุณที่ติดต่อเรา แอดมินจะรีบตอบกลับนะคะ';
}

async function handleMessage(event) {
  if (event.message?.type !== 'text' || !event.replyToken) return;

  const customerText = event.message.text.trim();
  const sourceId = event.source?.userId || event.source?.groupId || event.source?.roomId;
  const sourceType = event.source?.type || 'unknown';
  const adminText = [
    'มีข้อความใหม่จากลูกค้า',
    `ประเภทแชต: ${sourceType}`,
    sourceId ? `LINE ID: ${sourceId}` : null,
    `ข้อความ: ${customerText || '(ข้อความว่าง)'}`,
  ].filter(Boolean).join('\n');

  const results = await Promise.allSettled([
    lineApi('reply', {
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: automaticReply(customerText) }],
    }),
    lineApi('push', {
      to: ADMIN_LINE_TARGET,
      messages: [{ type: 'text', text: adminText }],
    }),
  ]);

  const failures = results.filter((result) => result.status === 'rejected');
  for (const failure of failures) {
    console.error('Failed to process LINE message:', failure.reason);
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} LINE message action(s) failed`);
  }
}

async function handleWebhook(request, response) {
  let body;
  try {
    body = await readRequestBody(request);
  } catch (error) {
    response.writeHead(error.statusCode || 400);
    response.end();
    return;
  }

  if (!verifySignature(body, request.headers['x-line-signature'])) {
    response.writeHead(401);
    response.end('Invalid signature');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    response.writeHead(400);
    response.end('Invalid JSON');
    return;
  }

  try {
    for (const event of payload.events || []) {
      await handleMessage(event);
    }
    response.writeHead(200);
    response.end('OK');
  } catch (error) {
    console.error('Webhook processing failed:', error);
    response.writeHead(502);
    response.end('Unable to process event');
  }
}

const missing = missingConfiguration();
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('OK');
      return;
    }

    if (request.method === 'POST' && request.url === '/webhook') {
      void handleWebhook(request, response);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  server.listen(PORT, () => {
    console.log(`LINE support bot listening on port ${PORT}`);
  });
}
