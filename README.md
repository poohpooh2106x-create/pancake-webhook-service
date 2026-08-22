# 🥞 PanCake Webhook Standalone Service (Netlify)

โปรเจกต์แยกอิสระ (Standalone) สำหรับรับ Webhook จาก PanCake CRM (เพจเคพี และ เพจเฮียตั้ม) และบันทึกข้อมูลลีดลง Google Sheets (ชีต `Facebook KP`) อัตโนมัติ

---

## 🌟 จุดเด่นของโปรเจกต์แยกตัวนี้

1. **เป็นเว็บอิสระแยกขาดจากเว็บเดิม:** ไม่ต้องแตะต้องหรือแก้ไขโค้ดของเว็บ `pancake-sales` เดิม
2. **มีหน้าเว็บ Dashboard ในตัว (`public/index.html`):** เมื่อเปิดหน้าเว็บหลัก จะมีหน้าสวยงามแสดงสถานะ พร้อมปุ่มคัดลอก URL และเครื่องมือทดสอบยิง Webhook จำลองได้ทันที
3. **ทำงานได้ทันทีแม้ยังไม่ต่อ Google Sheets (Log-Only Mode):**
   - ถ้ายังไม่ใส่กุญแจ Google Sheets: จะรับ Webhook, ตรวจจับเบอร์, แสดงข้อมูลลีดใน Netlify Logs และตอบกลับ 200 OK ให้ PanCake ทันที
   - ถ้าใส่กุญแจ Google Sheets: ข้อมูลจะวิ่งเข้าชีต `Facebook KP` คอลัมน์ A-E ทันที

---

## 🚀 ขั้นตอนการ Deploy เป็นเว็บใหม่บน Netlify (ทีละสเต็ป)

### 1. นำโฟลเดอร์นี้ขึ้น GitHub เป็น Repository ใหม่
1. ไปที่ [GitHub.com](https://github.com/) > กด **New repository**
2. ตั้งชื่อ เช่น `pancake-webhook-service`
3. ในคอมพิวเตอร์ของคุณ เปิด Terminal ในโฟลเดอร์นี้ (`C:\pancake-webhook-service`):
   ```bash
   git init
   git add .
   git commit -m "Initial commit for pancake webhook service"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/pancake-webhook-service.git
   git push -u origin main
   ```

---

### 2. สร้างเว็บใหม่บน Netlify (Add New Site)
1. เข้าไปที่ [app.netlify.com](https://app.netlify.com/)
2. กดปุ่ม **"Add new site"** > เลือก **"Import an existing project"**
3. เลือก **GitHub** > ค้นหาและเลือก Repository `pancake-webhook-service` ที่เพิ่งสร้าง
4. กด **Deploy pancake-webhook-service**
5. รอ 1 นาที คุณจะได้เว็บใหม่ทันที เช่น:
   ```text
   https://pancake-webhook-service.netlify.app
   ```
   *(หรือสามารถเปลี่ยนชื่อโดเมน Netlify ตามต้องการได้ที่ Site settings > Change site name)*

---

### 3. นำ Webhook URL ไปใส่ใน PanCake
เปิดหน้าเว็บของคุณ หรือใช้ URL:
```text
https://YOUR-SITE-NAME.netlify.app/api/webhooks/pancake
```
นำ URL นี้ไปใส่ใน **การตั้งค่า (Settings) > Webhook** ของทั้ง 2 เพจใน PanCake ("เพจเคพี" และ "เพจเฮียตั้ม") ได้ทันที!

---

### 4. (เมื่อพร้อม) เชื่อมต่อ Google Sheets
เมื่อคุณต้องการให้ข้อมูลบันทึกลงชีต `Facebook KP` คอลัมน์ A-E:
1. ไปที่ Netlify Dashboard > เลือกเว็บนี้ > **Site configuration** > **Environment variables**
2. เพิ่ม 3 ตัวแปร:
   - `SPREADSHEET_ID` = *ไอดี Google Sheets*
   - `SHEET_NAME` = `Facebook KP`
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = *ข้อความในไฟล์ JSON ของ Service Account*
3. กด **Trigger deploy** ข้อมูลจะบันทึกลง Google Sheets ทันทีครับ!
