/**
 * discord_notify.mjs — Send generation results to Discord via the Hermes bot
 * (REST API, bot token from hermes .env). Target channel: #flow-output.
 *
 * export: notifyDiscord({ title, description, imagePath?, videoPath?, color? })
 */
import fs from 'fs';
import path from 'path';
import { readFileSync } from 'fs';

const ENV_FILE = process.env.HERMES_ENV_FILE
  || '/home/hermes/DEV/api-custom-flow/.env.flow'
  || 'C:/Users/Lenovo/AppData/Local/hermes/.env';
const CHANNEL_FILE = process.env.FLOW_DISCORD_CHANNEL_FILE
  || '/home/hermes/DEV/api-custom-flow/.env.flow'
  || 'C:/Users/Lenovo/DEV/discord_channel.txt';
const FALLBACK_CHANNEL = '1546487558530269224'; // #flow-output

function getToken() {
  try {
    const env = readFileSync(ENV_FILE, 'utf8');
    const m = env.match(/DISCORD_BOT_TOKEN\s*=\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
function getChannel() {
  if (process.env.FLOW_DISCORD_CHANNEL) return process.env.FLOW_DISCORD_CHANNEL.trim();
  // อ่านจาก .env.flow
  try {
    const env = readFileSync(ENV_FILE, 'utf8');
    const m = env.match(/FLOW_DISCORD_CHANNEL\s*=\s*(.+)/);
    if (m) return m[1].trim();
  } catch {}
  try { return fs.readFileSync(CHANNEL_FILE, 'utf8').trim() || FALLBACK_CHANNEL; }
  catch { return FALLBACK_CHANNEL; }
}
export function discordConfigured() { return !!getToken(); }

export async function notifyDiscord({ title, description = '', imagePath = null, videoPath = null, color = 0x57F287 }) {
  const token = getToken();
  if (!token) { console.log('[discord] no bot token — skip'); return false; }
  const channelId = getChannel();
  const api = `https://discord.com/api/v10/channels/${channelId}/messages`;
  try {
    // Discord attachment limit 8MB/10MB (boost); skip video if bigger
    const atts = [];
    let filesPayload = {};
    if (videoPath && fs.existsSync(videoPath) && fs.statSync(videoPath).size < 7.5 * 1024 * 1024) {
      atts.push({ filename: path.basename(videoPath), description: 'วิดีโอโฆษณา' });
      filesPayload.video = videoPath;
      description += '\n📹 วิดีโอแนบด้านล่าง';
    } else if (videoPath && fs.existsSync(videoPath)) {
      description += '\n📹 วิดีโอ: ' + videoPath + ' (ไฟล์ใหญ่เกิน 8MB ไม่ส่งแนบได้)';
    }
    if (imagePath && fs.existsSync(imagePath) && atts.length === 0) {
      atts.push({ filename: path.basename(imagePath), description: 'ภาพโฆษณา' });
      filesPayload.image = imagePath;
    }
    const payload = {
      username: 'Hermes Flow Bot',
      embeds: [{ title: title.slice(0, 250), description: description.slice(0, 4000), color }]
    };
    let body, headers = { 'Authorization': 'Bot ' + token };
    if (atts.length) {
      const form = new FormData();
      let i = 0;
      const files = [];
      for (const a of atts) {
        const srcPath = filesPayload.video && i === 0 ? videoPath : imagePath;
        const buf = fs.readFileSync(srcPath);
        form.append(`files[${i}]`, new Blob([buf]), a.filename);
        files.push({ id: i, filename: a.filename, description: a.description });
        i++;
      }
      payload.attachments = files;
      form.append('payload_json', JSON.stringify(payload));
      body = form;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    }
    const r = await fetch(api, { method: 'POST', headers, body });
    if (!r.ok) console.error('[discord] send failed:', r.status, (await r.text()).slice(0, 150));
    else console.log('[discord] sent:', title.slice(0, 60));
    return r.ok;
  } catch (e) {
    console.error('[discord] error:', e.message.slice(0, 120));
    return false;
  }
}
