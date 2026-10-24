# เริ่มใช้งาน StackCabin

รุ่นนี้เป็นรุ่นพัฒนา 0.1.0 มีผลทดสอบบน Windows x64, Ubuntu และ macOS อ่านขอบเขตและงานก่อนเปิดตัว
ได้ใน [รายงานสถานะ](IMPLEMENTATION_STATUS.md)

## ติดตั้งบน Windows

แบบออนไลน์: เปิด `StackCabin_0.1.0_x64-setup.exe` ใน
`target/release/bundle/nsis/` แล้วติดตั้ง runtime ที่ต้องการจากหน้า Runtimes
ตัวติดตั้งรวม Visual C++ x64 ที่ตรึงเวอร์ชันและตรวจลายเซ็น Microsoft ไว้แล้ว
หากต้องติดตั้งหรืออัปเดตส่วนนี้ Windows อาจขอสิทธิ์ผู้ดูแลระบบ ส่วน WebView2
จะดาวน์โหลดเมื่อเครื่องยังไม่มี

แบบออฟไลน์: คัดลอกโฟลเดอร์ `artifacts/offline-windows-x64` ทั้งโฟลเดอร์ไปยัง
เครื่องปลายทาง แล้วเปิด `Install.cmd` ตัวช่วยจะตรวจ checksum และติดตั้ง
Visual C++ กับ WebView2 ที่จำเป็น ก่อนเปิดตัวติดตั้ง StackCabin
Windows อาจขอสิทธิ์ผู้ดูแลระบบสำหรับส่วนประกอบของ Microsoft
หลังเปิดแอป เลือก Runtimes → Install from offline pack แล้วเลือกโฟลเดอร์ชุดออฟไลน์

ตัวแอปรุ่นพัฒนายังไม่ได้ลงลายเซ็นสำหรับเผยแพร่สาธารณะ การติดตั้งและอัปเกรดบน
เครื่องสะอาดยังต้องผ่านการรับรองตามรายการในรายงานสถานะ

## แพ็กเกจทดลองสำหรับ Linux และ macOS

ใน GitHub Actions ใช้ workflow **Build and verify development installers** เพื่อ
สร้างแพ็กเกจทดลอง เลือก target เฉพาะระบบได้ ไฟล์อยู่ใน Artifacts ของแต่ละ run
และเก็บไว้ 7 วัน แพ็กเกจเหล่านี้ยังไม่ได้เผยแพร่เป็น release สาธารณะ

Linux มี `.deb` และ `.AppImage` โดยไฟล์ที่สร้างบน Ubuntu 22.04 ผ่านการเปิดแอป
บน Ubuntu 24.04 แล้ว การรัน AppImage บนเครื่องที่ไม่มี FUSE ใช้:

```sh
chmod +x StackCabin_*.AppImage
APPIMAGE_EXTRACT_AND_RUN=1 ./StackCabin_*.AppImage
```

macOS แยก `.dmg` สำหรับ Apple Silicon และ Intel โดยผ่านการเปิดแอปบน macOS 14
ทั้ง ARM และ x64 ผ่าน Rosetta แล้ว ดูขอบเขตใน [รายงานสถานะ](IMPLEMENTATION_STATUS.md)
Node.js และเว็บ Static ใช้ catalog ปัจจุบันได้
ส่วน PHP/ฐานข้อมูลบน Unix จะเพิ่มเข้า catalog หลังแพ็กเกจผ่านการตรวจและมีแหล่งดาวน์โหลดจริง

สำหรับผู้ทดสอบ VM มี [คู่มือรับรองเครื่องสะอาด](VM_ACCEPTANCE.md) และ workflow
สร้างชุดทดสอบ Windows แบบพกพาที่ใช้ runtime ของ StackCabin โดยไม่ต้องติดตั้ง Rust/Node/PHP ของระบบ

## โปรเจกต์แรก

1. กด New project เลือกโฟลเดอร์แม่ ชื่อ และ template หรือ Import project เพื่อนำเข้าโฟลเดอร์เดิม
2. เปิดรายละเอียดโปรเจกต์ เลือก PHP/Node.js ในแท็บ Configuration แล้วบันทึก
3. เลือก Set up runtimes เพื่อติดตั้งเวอร์ชันที่เลือกและเครื่องมือที่จำเป็น
4. ตรวจคำสั่งที่จะรันก่อนเปิด Trust project แล้วเลือก Install dependencies
5. กด Start ดูสถานะและ log แล้วเปิด URL ของโปรเจกต์
6. หากชื่อ `.localhost` ใช้งานไม่ได้ ใช้ URL สำรอง `http://127.0.0.1:...` ในรายละเอียดโปรเจกต์

การติดตั้ง dependencies ของ Laravel/npm/Composer อาจต้องใช้อินเทอร์เน็ต
ชุดออฟไลน์มี runtime และบริการ ส่วน dependencies ต้องติดตั้งไว้สำหรับระบบนั้น
หรือมี cache ที่พร้อมใช้ โปรเจกต์ที่นำเข้าอาจรันคำสั่งด้วยสิทธิ์ของผู้ใช้ จึงควรตรวจโค้ดก่อนให้ความเชื่อถือ

## ฐานข้อมูลและ backup

ในแท็บ Database เลือก SQLite, MariaDB หรือ PostgreSQL สำหรับ MariaDB/PostgreSQL
ให้ติดตั้ง runtime ของฐานข้อมูลจาก Runtimes ก่อน แอปสร้าง database/user แยกให้แต่ละโปรเจกต์
และเก็บรหัสผ่านใน Windows Credential Manager โดยส่งค่าการเชื่อมต่อให้ process ผ่าน environment
สามารถใช้ช่อง SQL ทดสอบการสร้างตารางและอ่านข้อมูลได้

เลือก Create backup เพื่อสำรอง source และข้อมูลฐานข้อมูล แอปหยุดโปรเจกต์ชั่วคราว
ระหว่างสำรอง แล้วเริ่มใหม่หากก่อนหน้านั้นกำลังรัน การกู้คืนต้องเลือกโฟลเดอร์ใหม่
และจะสร้างฐานข้อมูล/บัญชีใหม่ ไม่เขียนทับโฟลเดอร์เดิม

ค่าเริ่มต้นไม่รวม `node_modules`, `vendor`, `.env`, private keys และค่าลับใน manifest
จึงต้องตั้งค่า secrets และติดตั้ง dependencies อีกครั้งหลังการกู้คืน

## การตั้งค่าและการหยุดแอป

เปลี่ยนภาษาและธีมได้ใน Settings เมื่อเปิดตัวเลือก System Tray การปิดหน้าต่าง
จะซ่อนแอปไว้ที่ tray ใช้ Quit StackCabin จากเมนู tray เพื่อหยุดบริการของแอปและออก
การนำโปรเจกต์ออกจากรายการเก็บไฟล์ต้นฉบับไว้

หาก runtime ติดตั้งไม่สำเร็จ ให้ดู Logs และลองติดตั้งใหม่ แอปตรวจ checksum
และไม่แสดงการติดตั้งที่ค้างกลางทางเป็น Installed หาก PostgreSQL แจ้งปัญหาพาธ
ให้ดูคำอธิบายใน log และ [สถาปัตยกรรม](ARCHITECTURE.md)

## พัฒนาจากซอร์ส

ติดตั้ง Node.js, Rust และเครื่องมือระบบตาม [README](../README.md) แล้วรัน:

```sh
npm ci
npm run desktop
```

`npm run dev` เปิดเฉพาะหน้าจอในเบราว์เซอร์ การจัดการไฟล์ runtime และ process ต้องใช้แอป Desktop
