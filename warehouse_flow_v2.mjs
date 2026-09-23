#!/usr/bin/env node
/**
 * warehouse_flow_v2.mjs — Pure Background Wire Runner for Warehouse (:8899)
 * 
 * Strict Doctrine & Architecture:
 * 1. ZERO UI interaction: No clicking, typing, or DOM manipulation.
 * 2. Pure Wire Batchexecute RPC via CDP in page context (Flowboard v1.3.0 wire protocol).
 * 3. Exact Warehouse Doctrine:
 *    - Product Image Preparation (Feed/Base64)
 *    - Hard Promo Hook Selection (Deterministic Hash)
 *    - Stage A: Gemini 3.1 Flash Lite Vision analyzes product image + formulas
 *               -> produces imagePrompt (EN) + dialog (TH, ~30 words)
 *    - Stage A Ad Image: Pure Wire RPC ogiZ0b (0 credits) -> saved to imgOut
 *    - Stage B Video: Upload Stage A image via RPC maseQ -> get startMediaId
 *                     -> Compose video prompt (บทพูด + กำหนด fixed block)
 *                     -> Submit Omni Flash (abra_r2v_8s / abra_r2v_10s) via RPC MZZa6b
 *                     -> Poll via RPC as29s and download MP4 to vidOut
 *    - Multi-Account Rotation: Rotates accounts in account_pool.json when credits depleted.
 *    - Progress & Discord: Updates :8899/api/progress, product_list.json, and notifies Discord.
 * 
 * Legacy Reference: warehouse_api_runner.mjs is preserved untouched.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  generateImage,
  uploadImageWire,
  submitOmniVideo,
  pollAndDownloadVideo
} from './flow_pure_wire.js';
import { getActiveAccount, selectNextAccount, recordCreditUsage, markAccountQuotaReached } from './account_rotator.mjs';
import { stageAGemini, stageAConfigured } from './gemini_stage_a.mjs';
import { notifyDiscord } from './discord_notify.mjs';

const DEV = process.env.FLOW_DEV_DIR || '/home/hermes/DEV';
const WAREHOUSE_URL = process.env.FLOW_WAREHOUSE_URL || 'http://127.0.0.1:8899';
const ONLY_ID = process.argv[2] || process.env.FLOW_ONLY_ID || '';

console.log('════════════════════════════════════════════════════════════');
console.log('  🚀 WAREHOUSE FLOW RUNNER V2 (EXACT DOCTRINE & PURE WIRE)');
console.log('════════════════════════════════════════════════════════════');

// ─── Preset Loading (Dashboard "จัดการสูตร") ────────────────────────
// Precedence: warehouse_state.json > custom_presets.json > _img_slim/_vid_slim
const PRESET_ALIASES = {
  '🔥Shopee100 Hard Promo 53%': '🔥 Shopee 100 — Hard Promo (เชียร์ขายไฟลุก 53%)',
  'Shopee100 Hard Promo 53%': '🔥 Shopee 100 — Hard Promo (เชียร์ขายไฟลุก 53%)',
  '💬Shopee100 Casual Review 32%': '💬 Shopee 100 — Casual Review (ป้ายยาเพื่อนบอกต่อ 32%)',
  '⭐Shopee100 Golden Formula': '⭐ Shopee 100 — Golden Formula'
};

function loadPresetsAll() {
  const dir = path.join(DEV, 'presets');
  const read = (f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch { return {}; }
  };
  const img = read('_img_slim.json');
  const vid = read('_vid_slim.json');
  let fromCustom = { image: {}, video: {} };
  let fromState = { image: {}, video: {} };
  try { fromCustom = JSON.parse(fs.readFileSync(path.join(dir, 'custom_presets.json'), 'utf8')); } catch {}
  try { fromState = JSON.parse(fs.readFileSync(path.join(DEV, 'warehouse_state.json'), 'utf8')).customPresets || { image: {}, video: {} }; } catch {}
  const delIds = fromState.__deleted || fromCustom.__deleted || [];
  const stripTomb = (obj) => { const o = { ...(obj || {}) }; for (const k of delIds) delete o[k]; return o; };
  const customImage = { ...stripTomb(fromCustom.image), ...stripTomb(fromState.image) };
  const customVideo = { ...stripTomb(fromCustom.video), ...stripTomb(fromState.video) };
  return {
    image: stripTomb({ ...img, ...customImage }),
    video: stripTomb({ ...vid, ...customVideo })
  };
}

let PRESETS = loadPresetsAll();

function findPreset(kind, name) {
  if (!name) return null;
  PRESETS = loadPresetsAll(); // Dynamic refresh from warehouse_state on demand
  const table = PRESETS[kind] || {};
  let p = Object.values(table).find(x => x.name === name);
  if (p) return p;
  const targetName = PRESET_ALIASES[name] || name;
  p = Object.values(table).find(x => x.name === targetName);
  if (p) return p;
  const clean = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\u0E00-\u0E7F]/g, '');
  const cTarget = clean(name);
  p = Object.values(table).find(x => {
    const cName = clean(x.name);
    return cName.includes(cTarget) || cTarget.includes(cName);
  });
  return p || null;
}

function expandTemplate(template, it) {
  if (!template) return '';
  return template
    .replace(/\{\{productName\}\}/g, it.product_name || '')
    .replace(/\{\{round\}\}/g, String(it.round || 1))
    .replace(/\{\{totalRounds\}\}/g, String(it.rounds || 1))
    .replace(/\{\{genderText\}\}/g, it.genderText || 'ผู้หญิง');
}

function composePresetPrompt(kind, it) {
  const preset = findPreset(kind, kind === 'image' ? it.image_preset : it.video_preset);
  if (!preset) return null;
  const parts = [];
  if (preset.systemPrompt) parts.push(preset.systemPrompt);
  if (preset.userMessageTemplate) parts.push(expandTemplate(preset.userMessageTemplate, it));
  return parts.filter(Boolean).join('\n\n');
}

// ─── Hard Promo Hooks ─────────────────────────────────────────────
const HARD_PROMO_HOOKS = [
  'วันนี้ได้ส่วนลดเยอะ', 'วันนี้ได้ราคาถูกมาก', 'วันโปรลดเยอะมาก', 'นาทีทองมาแล้ว',
  'ราคาโปรพิเศษ', 'ตัวดังตัวฮิตมาแล้ว', 'ทนกระแสไม่ไหวแล้ว', 'ตัวนี้ขายดีมากเลย',
  'กดวันนี้คุ้มที่สุด', 'ห้ามพลาดคลิปนี้', 'พลาดแล้วจะเสียใจ', 'หมดล็อตนี้รอนาน',
  'รีบมากดตะกร้านี้', 'ช้าหมดอดนะคะ', 'ไอเทมที่หลายคนตามหา', 'ของมันต้องมี',
  'ตัวดังในเน็ตเลย', 'กดด่วนก่อนหมด', 'โชคดีมากได้ราคานี้', 'ราคาพิเศษสุดๆ วันนี้'
];

function pickHook(productId, round) {
  const str = String(productId || '') + String(round || 1);
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HARD_PROMO_HOOKS[h % HARD_PROMO_HOOKS.length];
}

function injectHook(videoUserTemplate, videoPresetName, productId, round) {
  if (!videoUserTemplate) return videoUserTemplate;
  if (!/hard.promo/i.test(videoPresetName || '') && !/shopee.100/i.test(videoPresetName || '')) return videoUserTemplate;
  const hook = pickHook(productId, round);
  console.log('  🎣 Hook selected:', hook);
  if (videoUserTemplate.includes('{{hook}}')) {
    return videoUserTemplate.replace(/\{\{hook\}\}/g, hook);
  }
  return videoUserTemplate + '\n\nHook ที่ต้องใช้เปิดบทพูด (ห้ามเปลี่ยน): "' + hook + '"';
}

const RISKY_WORDS = /(ฟื้นฟู|ชะลอวัย|รักษา|cure|treat|heal|การันตี|100%|รับประกัน|กำจัด|รอยสิว|สิว|ฝ้า|กระ|ลดเลือน|ต้านจุลชีพ|ฆ่าเชื้อ|whitening)/gi;
function sanitize(p) {
  return String(p || '').replace(RISKY_WORDS, ' ').replace(/\s{2,}/g, ' ').trim();
}

// Boss's exact fixed director block
function buildVideoPrompt(dialog, duration) {
  return [
    'บทพูด : "' + String(dialog || '').replace(/["\\]/g, '') + '"',
    '',
    'กำหนด:เสียงผู้หญิงไทยพากย์เสียงมันส์ๆ มุมกล้องอยู่นิ่งๆขยับเล็กน้อยไม่ให้ดูเหมือนภาพนิ่ง ห้ามหมุนสินค้าเด็ดขาด ห้ามเห็นหน้าบุคคลในวิดีโอเด็ดขาด กำหนดให้เห็นแค่มือเท่านั้น ห้ามสลับฉาก ห้ามแตะ Product เด็ดขาด ทำท่านิ้วชี้ไปที่ Product เท่านั้น All dialogues must be in Thai language only. NO onscreen text, NO subtitles, NO typography, NO captions anywhere in the video. All dialogues must be in Thai language only.',
    '-เสียงต้องพูดชัดเจน .',
    '-ผลิตภัณฑ์ยังคงมีรูปร่างและสีเหมือนเดิมทุกประการ.',
    '-ห้ามมีข้อความ,ห้ามมีโลโก้,ห้ามมีซับ,ห้ามการเด้งของป้ายโชว์.',
    '-รูปภาพแบบ FOV ไม่มีคนพูดหน้าฉาก กำหนดให้เห็นแค่มือเท่านั้น.',
    '-ไม่มีเสียงอื่นแทรก,ห้ามมีเสียงน้ำไหล,ห้ามมีเสียงลม.'
  ].join('\n');
}

async function reportProgress(id, status, note = '', output_video = '') {
  try {
    const payload = JSON.stringify({ id, status, note, output_video });
    await fetch(`${WAREHOUSE_URL}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  } catch (err) {
    console.warn(`[Report Warn] Could not notify Warehouse :8899:`, err.message);
  }
}

function saveProductList(data) {
  const p = path.join(DEV, 'product_list.json');
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

function downloadFile(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execSync(`curl -sL --retry 3 "${url}" -o "${dest}"`);
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    throw new Error(`Failed to download file from ${url}`);
  }
  return dest;
}

// ─── Main Pipeline ────────────────────────────────────────────────
async function run() {
  const queueFile = path.join(DEV, 'product_list.json');
  if (!fs.existsSync(queueFile)) {
    console.error(`Queue file not found: ${queueFile}`);
    process.exit(1);
  }

  const queueData = JSON.parse(fs.readFileSync(queueFile, 'utf-8'));
  const items = queueData.items || [];

  const idsArg = process.argv.find(a => a.startsWith('--ids='));
  const targetIds = idsArg
    ? idsArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean)
    : (ONLY_ID && !ONLY_ID.startsWith('--') ? [ONLY_ID] : null);

  const pendingItems = items.filter(it => {
    // If specific target IDs were requested (e.g. "ส่งที่เลือกไปเจน"):
    if (targetIds && targetIds.length > 0) {
      return targetIds.includes(it.id);
    }
    // Otherwise, ONLY process items explicitly in 'queued' status!
    return it.status === 'queued';
  });

  if (pendingItems.length === 0) {
    console.log('✅ No pending items matching filter to process.');
    process.exit(0);
  }

  console.log(`📋 Found ${pendingItems.length} items to process (Filter: ${targetIds ? targetIds.join(', ') : 'all queued'}).`);

  for (const it of pendingItems) {
    // Respect card selection: Omni 10s default
    const dur = it.duration || '10s';
    const durSeconds = parseInt(dur) || 10;
    const requiredCredits = durSeconds >= 10 ? 15 : 7;

    const winSafe = s => (s || '').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim();
    const safeProductName = winSafe(it.product_name || 'product').slice(0, 25) || 'product';
    const safeImagePreset = winSafe(it.image_preset || 'no-img-preset').slice(0, 15);
    const safeVideoPreset = winSafe(it.video_preset || 'no-vid-preset').slice(0, 15);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const roundStr = (it.round || 1) + 'of' + (it.rounds || 1);
    const ratioStr = (it.ratio || '9:16').replace(':', '');

    const today = new Date().toISOString().slice(0, 10);
    const dateBatch = `${today}_batch${today.slice(5, 7)}${today.slice(8, 10)}`;
    const itemDir = path.join(DEV, 'media', 'output', dateBatch, it.id);
    fs.mkdirSync(itemDir, { recursive: true });

    const imgOut = path.join(itemDir, `${dateStr}_${safeProductName}_${safeImagePreset}_${roundStr}_${ratioStr}.jpg`);
    const vidOut = path.join(itemDir, `${dateStr}_${safeProductName}_${safeVideoPreset}_${roundStr}_${ratioStr}_${dur}.mp4`);

    console.log('\n────────────────────────────────────────────────────────────');
    console.log(`🎬 Processing Item: ${it.id} (${safeProductName})`);
    console.log(`   Round: ${it.round}/${it.rounds} | Ratio: ${it.ratio || '9:16'} | Dur: ${dur}`);

    // Product Image Resolution
    let imgPath = path.join(DEV, 'media', 'feed', `${it.product_id}.jpg`);
    const feedImgDirect = path.join(DEV, 'media', 'feed', `feed_${it.product_id}.jpg`);
    const altImgPath = path.join(DEV, 'media', `feed_${it.product_id}.jpg`);

    if (fs.existsSync(feedImgDirect)) {
      imgPath = feedImgDirect;
    } else if (!fs.existsSync(imgPath) && fs.existsSync(altImgPath)) {
      imgPath = altImgPath;
    } else if (!fs.existsSync(imgPath)) {
      if (it.image_data?.startsWith('data:image')) {
        fs.writeFileSync(imgPath, Buffer.from(it.image_data.split(',')[1], 'base64'));
        console.log('  extracted product image from item.image_data');
      } else {
        it.status = 'failed';
        await reportProgress(it.id, 'failed', 'product_image_not_found');
        continue;
      }
    }

    try {
      // 1. Account & Credits Rotation
      let account;
      try {
        account = await selectNextAccount(requiredCredits);
      } catch (errRot) {
        if (errRot.message && errRot.message.includes('ALL_ACCOUNTS_EXHAUSTED')) {
          console.log(`🛑 [HALT] All Google Flow accounts have exhausted their credits. Stopping queue runner.`);
          await reportProgress(it.id, 'queued', 'หยุดรัน: เครดิตหมดทุกบัญชีในระบบแล้ว');
          process.exit(0);
        }
        throw errRot;
      }
      let cdpPort = account.port || 9333;
      console.log(`👤 Active Account: ${account.id} (${account.email}) on CDP port ${cdpPort}`);

      // 1. Upload Product Image to Google Flow
      await reportProgress(it.id, 'running', 'uploading product image');
      console.log(`📤 Uploading product image to Google Flow (RPC maseQ)...`);
      const prodUploadRes = await uploadImageWire({
        imagePath: imgPath,
        fileName: path.basename(imgPath),
        cdpPort
      });
      const productMediaId = prodUploadRes.mediaId;
      console.log(`  ✅ Product image uploaded: productMediaId=${productMediaId}`);

      // 2. Stage A: Gemini Vision Analysis
      await reportProgress(it.id, 'running', 'Gemini วิเคราะห์รูปสินค้า + เขียน imagePrompt (EN) + บทพูด (TH)');
      let dialogFromAI = null;
      let imagePromptFromAI = null;

      const presetV = findPreset('video', it.video_preset);
      const presetI = findPreset('image', it.image_preset);
      const productB64 = fs.readFileSync(imgPath).toString('base64');

      if (stageAConfigured()) {
        console.log('  🧠 Invoking Gemini Stage A (Gemini 3.1 Flash Lite Vision)...');
        const ai = await stageAGemini({
          imageSystemPrompt: presetI?.systemPrompt || '',
          videoSystemPrompt: presetV?.systemPrompt || '',
          imageUserTemplate: presetI?.userMessageTemplate || '',
          videoUserTemplate: injectHook(presetV?.userMessageTemplate || '', it.video_preset, it.product_id, it.round),
          productImageB64: productB64,
          productName: it.product_name || '',
          duration: dur
        });

        if (ai?.dialog) {
          dialogFromAI = ai.dialog;
          console.log('  ✨ Stage A (Gemini) dialog:', ai.dialog);
        }
        if (ai?.imagePrompt) {
          imagePromptFromAI = ai.imagePrompt;
          console.log('  ✨ Stage A (Gemini) imagePrompt (EN):', ai.imagePrompt.slice(0, 100) + '...');
        }
      }

      // 3. Stage A: Pure Wire Image Generation (0 Credits) WITH ATTACHED PRODUCT REFERENCE
      await reportProgress(it.id, 'running', 'generating image');
      const finalImgPrompt = imagePromptFromAI || composePresetPrompt('image', it) || `Commercial product photography of ${it.product_name}, clean modern aesthetic, soft natural lighting, 8k.`;
      const safeImgPrompt = sanitize(finalImgPrompt);

      console.log(`  📸 Submitting Image RPC (ogiZ0b) with aspect ${it.ratio || '9:16'} and attached product reference (${productMediaId.slice(0, 8)})...`);
      const imgRes = await generateImage({
        prompt: safeImgPrompt,
        referenceMediaIds: [productMediaId],
        aspect: it.ratio || '9:16',
        cdpPort
      });

      console.log(`  📥 Downloading Stage A image to: ${imgOut}`);
      downloadFile(imgRes.url, imgOut);
      console.log(`  ✅ Stage A Image saved!`);

      // 4. Stage B: Upload Stage A image as Start Image
      await reportProgress(it.id, 'running', 'uploading generated image');
      console.log(`📤 Uploading Stage A image to Google Flow (RPC maseQ)...`);
      const uploadRes = await uploadImageWire({
        imagePath: imgOut,
        fileName: path.basename(imgOut),
        cdpPort
      });
      const startMediaId = uploadRes.mediaId;
      console.log(`  ✅ Start Image uploaded: mediaId=${startMediaId}`);

      // 5. Stage B: Build Video Prompt & Submit Omni Flash
      await reportProgress(it.id, 'running', `Stage B: Submitting Omni Flash video (${dur})`);
      const speech = it.speech_th || '';
      const dialog = speech || dialogFromAI || '';

      const vidPrompt = dialog
        ? buildVideoPrompt(dialog, dur)
        : sanitize(composePresetPrompt('video', it) || buildVideoPrompt('สินค้านี้คุ้มค่ามาก รีบกดก่อนหมดนะคะ', dur));

      let vidSub = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          console.log(`🎥 Submitting Omni Flash Video RPC (MZZa6b) [Model: abra_r2v_${durSeconds}s, Aspect: ${it.ratio || '9:16'}]...`);
          vidSub = await submitOmniVideo({
            prompt: vidPrompt,
            referenceMediaIds: [startMediaId],
            durationS: durSeconds,
            aspect: it.ratio || '9:16',
            cdpPort
          });
          break;
        } catch (e) {
          if (attempt === 0 && e.message && (e.message.includes('USER_QUOTA_REACHED') || e.message.includes('QUOTA'))) {
            console.log(`⚠️ User quota reached on ${account.id}. Marking exhausted and rotating to next account...`);
            markAccountQuotaReached(account.id);
            try {
              account = await selectNextAccount(requiredCredits);
            } catch (errRot) {
              if (errRot.message && errRot.message.includes('ALL_ACCOUNTS_EXHAUSTED')) {
                console.log(`🛑 [HALT] All accounts exhausted after quota reached. Stopping runner.`);
                await reportProgress(it.id, 'queued', 'หยุดรัน: เครดิตหมดทุกบัญชีในระบบแล้ว');
                process.exit(0);
              }
              throw errRot;
            }
            cdpPort = account.port || 9333;
            console.log(`📤 Re-uploading Stage A image to new account ${account.id}...`);
            const reUp = await uploadImageWire({
              imagePath: imgOut,
              fileName: path.basename(imgOut),
              cdpPort
            });
            startMediaId = reUp.mediaId;
            continue;
          }
          throw e;
        }
      }
      console.log(`  🚀 Video Task queued: operationId=${vidSub.operationId}, mediaId=${vidSub.mediaId}`);

      // 6. Polling & Downloading Video
      await reportProgress(it.id, 'running', `Stage B: Rendering Omni Flash video (${dur})`);
      console.log(`⏳ Waiting for video render completion...`);
      await pollAndDownloadVideo({
        mediaId: vidSub.mediaId,
        outputPath: vidOut,
        cdpPort,
        maxWaitSec: 300,
        pollIntervalSec: 6,
        onProgress: (sec) => {
          if (sec % 18 === 0) console.log(`  ... rendering in progress (${sec}s elapsed)`);
        }
      });
      console.log(`  🎉 Video generated and saved: ${vidOut}`);

      // 7. Credits & Status Record
      recordCreditUsage(requiredCredits);
      it.status = 'done';
      it.output_video = vidOut;
      it.updated_at = new Date().toISOString();
      it.progress_note = `done (Omni Flash ${dur} ${it.ratio || '9:16'})`;
      saveProductList(queueData);
      await reportProgress(it.id, 'done', 'completed', vidOut);

      // 8. Notify Discord
      try {
        console.log('📢 Sending completion notice to Discord...');
        const creditsLeft = account.daily_credit_limit - (account.credits_used_today + requiredCredits);
        await notifyDiscord({
          title: '✅ วิดีโอเสร็จ: ' + (it.product_name || it.id),
          description: 'รอบ ' + (it.round || '?') + '/' + (it.rounds || '?') + ' | ' + (it.ratio || '9:16') + ' ' + dur + '\nสูตรภาพ: ' + (it.image_preset || '-') + '\nสูตรวิดีโอ: ' + (it.video_preset || '-') + '\nบทพูด: ' + (dialog ? dialog.slice(0, 100) + '...' : '-') + '\nเครดิตคงเหลือ: ' + creditsLeft,
          imagePath: imgOut,
          videoPath: vidOut
        });
      } catch (discErr) {
        console.warn('⚠️ Discord notify warning:', discErr.message);
      }

      console.log(`✅ Completed ${it.id} successfully!`);

    } catch (err) {
      console.error(`❌ Failed processing ${it.id}:`, err.message);
      it.status = 'failed';
      it.progress_note = `error: ${err.message.slice(0, 100)}`;
      it.updated_at = new Date().toISOString();
      saveProductList(queueData);
      await reportProgress(it.id, 'failed', err.message);

      try {
        await notifyDiscord({
          title: '❌ เจนไม่สำเร็จ: ' + (it.product_name || it.id),
          description: 'เหตุผล: ' + err.message.slice(0, 300),
          color: 0xED4245
        });
      } catch {}
    }
  }

  console.log('\n🏁 Batch processing finished.');
}

run().catch(err => {
  console.error('Fatal Runner Error:', err);
  process.exit(1);
});
