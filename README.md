# Google Flow V2 Automation & Warehouse Pipeline 🚀

ระบบสร้างสรรค์วิดีโอและรูปภาพสินค้าแบบอัตโนมัติ 100% เชื่อมโยงกับ Google Flow (`flow.google.com`) และ Warehouse Dashboard (`:8899`) พัฒนาบนสถาปัตยกรรม **Pure Wire Protocol** ตามแนวทางของ `crisng95/flowboard` v1.3.0

---

## 🌟 จุดเด่นของระบบ V2 (Core Doctrine)

1. **Pure Background Wire RPC (ZERO UI Interaction):**
   - ไม่มีการคลิก พิมพ์ หรือจำลองผ่าน DOM หน้าเว็บเด็ดขาด
   - สื่อสารผ่าน Batchexecute RPC (`ogiZ0b`, `maseQ`, `MZZa6b`, `as29s`) บน MAIN-world context
   - เปิด Google Chrome เพียง **หน้าต่างเดียว แท็บเดียว** ค้างไว้เพื่อใช้เป็น Session & reCAPTCHA Enterprise Anchor
2. **ระบบหมุนเวียนบัญชีอัตโนมัติ (Multi-Account Rotation):**
   - รองรับการหมุนเวียนเครดิตอัตโนมัติเมื่อเครดิตเหลือน้อยกว่า 15 (สำหรับ Omni Flash 10s)
   - สลับโปรไฟล์ Chrome เบื้องหลังแบบ Single-window ไร้รอยต่อ ไม่รกหน้าจอ
   - ระบบ Failover อัตโนมัติเมื่อติดโควตาฝั่ง Google (`PUBLIC_ERROR_USER_QUOTA_REACHED`)
3. **Omni Flash 10s เป็นค่าเริ่มต้น:**
   - ใช้โมเดล `abra_r2v_10s` (15 Credits) และเคารพการตั้งค่าบนการ์ดสินค้าในคลัง
   - รองรับ Aspect Ratio 9:16 (แนวตั้ง), 16:9 (แนวนอน), 1:1 (จัตุรัส)
4. **กระบวนการแนบรูปภาพอ้างอิงสินค้าจริง (2-Stage Pipeline):**
   - **Stage 1 (Upload):** อัปโหลดรูปภาพสินค้าจริงจาก Feed ขึ้น Google Flow (`maseQ`)
   - **Stage 2 (Vision & Image Gen):** วิเคราะห์ภาพด้วย Gemini 3.1 Flash Lite ➔ เจนภาพ Stage A ผ่าน `ogiZ0b` พร้อมแนบ `referenceMediaIds` เพื่อคงโลโก้และรูปทรงสินค้าจริง
   - **Stage 3 (Video Gen):** นำภาพ Stage A เป็น Start Image ส่งเข้า Omni Flash ➔ เจนคลิปวิดีโอพร้อมบทพูดและ Hook โฆษณา
5. **คลังสูตรกำกับโฆษณา (27 สูตรรูป / 17 สูตรวิดีโอ):**
   - ซิงก์สูตรแบบ Dynamic จากหน้าเว็บ `:8899/warehouse.html` ลง `warehouse_state.json`
   - ระบบ Alias Mapping เชื่อมชื่อการ์ดกับสูตรเต็มอย่างแม่นยำ
6. **Live Monitor & Activity Log:**
   - มอนิเตอร์ Log กิจกรรมระบบและคิวงานแบบเรียลไทม์ทุก 3 วินาที

---

## 📁 โครงสร้างโปรเจกต์

```text
├── core/
│   ├── flow_pure_wire.js      # Pure Wire RPC Client (maseQ, ogiZ0b, MZZa6b, as29s, unhijackCaptcha)
│   ├── account_rotator.mjs    # ระบบเลือกและสลับบัญชี Google Flow
│   ├── gemini_stage_a.mjs     # Gemini Vision + แต่งบทพูดและ Hook โฆษณา
│   └── discord_notify.mjs     # แจ้งเตือนสถานะและคลิปวิดีโอเข้า Discord
├── presets/
│   ├── _img_slim.json         # คลังสูตรภาพมาตรฐาน (26 สูตร)
│   ├── _vid_slim.json         # คลังสูตรวิดีโอมาตรฐาน (13 สูตร)
│   └── custom_presets.json    # สูตรเพิ่มเติมจากระบบ
├── warehouse_flow_v2.mjs      # ตัวรันเนอร์หลักเชื่อม Warehouse กับ Google Flow
├── warehouse-server.js        # Backend API สำหรับ Dashboard (:8899)
├── warehouse.html             # หน้า UI จัดการคลังสินค้าและมอนิเตอร์
└── account_pool.example.json  # โครงสร้างตัวอย่างสำหรับจัดการบัญชี
```

---

## ⚙️ การติดตั้งและใช้งาน

### 1. ติดตั้ง Dependencies
```bash
npm install
```

### 2. ตั้งค่าคลังบัญชี (`account_pool.json`)
คัดลอกไฟล์ตัวอย่าง:
```bash
cp account_pool.example.json account_pool.json
```
ระบุพาธโปรไฟล์ Chrome (`profile_dir`) และ `project_id` ของแต่ละบัญชี

### 3. เริ่มต้นระบบเซิร์ฟเวอร์คลังสินค้า
```bash
node warehouse-server.js
```
เปิดเข้าใช้งานผ่านเบราว์เซอร์: `http://localhost:8899/warehouse.html`

### 4. รันระบบสร้างสรรค์วิดีโอ
กดปุ่ม **"รันคิว"** หรือ **"ส่งที่เลือกไปเจน"** จากหน้า Dashboard หรือรันผ่านคำสั่ง:
```bash
node warehouse_flow_v2.mjs
```

---

## 🛡️ สิทธิประโยชน์และการป้องกัน Anti-bot
ระบบรวมฟังก์ชัน `unhijackCaptcha` เพื่อปลดล็อก reCAPTCHA Enterprise ที่ Google Flow อาจ Monkey-patch ป้องกันไม่ให้เกิดปัญหา 403 Forbidden หรือ Honeypot ดักบอท ทำให้การยิง Background Wire RPC เสถียรและราบรื่น 100%
