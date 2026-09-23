/**
 * gemini_stage_a.mjs — Stage A of the 2-stage pipeline:
 *   Uses preset systemPrompt + userMessageTemplate from dashboard
 *   Sends to Gemini (via OpenRouter) with product image
 *   Returns { imagePrompt (EN), dialog (TH) } — whatever Gemini replies
 *
 * Config:
 *   API key:  C:/Users/Lenovo/DEV/openrouter_api_key.txt or OPENROUTER_API_KEY env
 *   Model:    google/gemini-3.1-flash-lite (vision-capable)
 */
import fs from 'fs';

const KEY_FILE = process.env.OPENROUTER_KEY_FILE || (fs.existsSync('/home/hermes/DEV/openrouter_api_key.txt') ? '/home/hermes/DEV/openrouter_api_key.txt' : 'C:/Users/Lenovo/DEV/openrouter_api_key.txt');
const MODEL = 'google/gemini-3.1-flash-lite';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

function getKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    const t = fs.readFileSync(KEY_FILE, 'utf8').trim();
    return t.startsWith('sk-or-') ? t : null;
  } catch { return null; }
}
export function stageAConfigured() { return !!getKey(); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callOpenRouter(apiKey, body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (r.ok) {
      const j = await r.json();
      return j.choices?.[0]?.message?.content || '';
    }
    if (r.status === 429 || r.status >= 500) {
      await sleep(attempt * 3000);
      continue;
    }
    throw new Error('OpenRouter ' + r.status + ': ' + (await r.text()).slice(0, 200));
  }
  throw new Error('OpenRouter retries exhausted');
}

/**
 * Uses dashboard presets directly:
 * - imageSystemPrompt: from selected image preset's systemPrompt
 * - imageUserTemplate: from selected image preset's userMessageTemplate
 * - videoSystemPrompt: from selected video preset's systemPrompt
 * - videoUserTemplate: from selected video preset's userMessageTemplate
 *
 * Sends to Gemini with product image. Returns { imagePrompt, dialog }.
 */
export async function stageAGemini({
  imageSystemPrompt,
  imageUserTemplate,
  videoSystemPrompt,
  videoUserTemplate,
  productImageB64,
  productName,
  duration
}) {
  const apiKey = getKey();
  if (!apiKey) return null;

  const sys = [
    'You have TWO tasks. Analyze the attached product image, then:',
    '',
    '=== TASK 1: imagePrompt (for ad image generation) ===',
    imageSystemPrompt || '',
    '',
    '=== TASK 2: dialog (Thai sales script for the video) ===',
    videoSystemPrompt || 'เขียนบทพูดขายสินค้าภาษาไทย ~35 คำ (Hook + Benefit + CTA)',
    '',
    'OUTPUT FORMAT — strict JSON only: {"imagePrompt": "English prompt for NARWHAL", "dialog": "บทพูดภาษาไทย ~35 คำ"}',
    'No markdown, no commentary, reply with the JSON only.'
  ].filter(Boolean).join('\n');

  const user = [
    '=== สำหรับ imagePrompt ===',
    imageUserTemplate ? imageUserTemplate.replace(/\{\{productName\}\}/g, productName || '') : '',
    '=== สำหรับ dialog ===',
    videoUserTemplate ? videoUserTemplate.replace(/\{\{productName\}\}/g, productName || '') : '',
    'รูปสินค้าแนบมาด้านบน — วิเคราะห์ก่อนเขียน imagePrompt (EN) และ dialog (TH)'
  ].filter(Boolean).join('\n');

  const body = {
    model: MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + productImageB64 } },
        { type: 'text', text: sys + '\n\n=== PRODUCT INFO ===\n' + user }
      ]
    }],
    max_tokens: 2048,
    response_format: { type: 'json_object' }
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callOpenRouter(apiKey, body);
      let text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const j = JSON.parse(text);
      if (!j.dialog || !j.imagePrompt) throw new Error('missing dialog or imagePrompt in response: ' + text.slice(0, 150));
      return { dialog: j.dialog, imagePrompt: j.imagePrompt };
    } catch (e) {
      if (attempt === 2) { console.error('[stageA] failed:', e.message.slice(0, 150)); return null; }
      await sleep(3000);
    }
  }
  return null;
}