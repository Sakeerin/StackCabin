# เริ่มใช้งาน StackCabin

รุ่นนี้เป็นรุ่นพัฒนา 0.1.0 มีผลทดสอบบน Windows x64, Ubuntu และ macOS อ่านขอบเขตและงานก่อนเปิดตัว
ได้ใน [รายงานสถานะ](IMPLEMENTATION_STATUS.md)

## ติดตั้งบน Windows

ดาวน์โหลดแพ็กเกจวันที่ 29 ตุลาคม 2026 จาก
[GitHub Actions run นี้](https://github.com/Sakeerin/StackCabin/actions/runs/40812811594)
เลือก Artifact `development-installers-windows-latest` แล้วแตก ZIP และตรวจไฟล์
ตาม `SHA256SUMS.txt` ไฟล์ติดตั้งอยู่ในโฟลเดอร์ `nsis/` ส่วนแพ็กเกจจากการ build เอง
อยู่ใน `target/release/bundle/nsis/` Artifact เก็บไว้ 7 วัน

แบบออนไลน์: เปิด `StackCabin_0.1.0_x64-setup.exe` ใน
โฟลเดอร์แพ็กเกจที่เลือก แล้วติดตั้ง runtime ที่ต้องการจากหน้า Runtimes
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

macOS แยก `.dmg` สำหรับ Apple Silicon และ Intel แพ็กเกจวันที่ 29 ตุลาคมผ่านการเปิดแอป
บน macOS 15 ทั้งสองสถาปัตยกรรม ผลทดสอบ macOS 14 ของแพ็กเกจรุ่นก่อนหน้ารวมไว้ใน
[รายงานสถานะ](IMPLEMENTATION_STATUS.md)
Node.js และเว็บ Static ใช้ catalog ปัจจุบันได้
ส่วน PHP/ฐานข้อมูลบน Unix จะเพิ่มเข้า catalog หลังแพ็กเกจผ่านการตรวจและมีแหล่งดาวน์โหลดจริง

## ทดสอบ PHP และฐานข้อมูลบน Linux/macOS ด้วย StackCabin QA

ใช้ workflow **Build Unix QA desktop installers with offline runtimes** เพื่อสร้าง
**StackCabin QA** พร้อม PHP 8.4/8.5, Node.js 22/24, MariaDB, PostgreSQL และเครื่องมือที่ตรงกัน
เลือก `linux`, `macos-arm64` หรือ `macos-x64` ให้ตรงกับเครื่อง ไฟล์อยู่ใน Artifact
ชื่อ `desktop-qa-*` และเก็บไว้ 7 วัน

1. ดาวน์โหลด `.tar.gz` พร้อม `.sha256` ตรวจ checksum แล้วแตกไฟล์
2. ตรวจไฟล์ติดตั้งตาม `installers/SHA256SUMS.txt` จากนั้นติดตั้ง `.deb`/เปิด AppImage
   หรือคัดลอก **StackCabin QA.app** จาก `.dmg`
3. เปิดแอปด้วยบัญชีผู้ใช้ปกติ และปลดล็อก Keychain/Secret Service ของระบบ
4. เปิด Runtimes → Install from offline pack เลือกโฟลเดอร์ `offline` จากชุดเดียวกัน
   แล้วติดตั้งภาษาและเครื่องมือที่ต้องการก่อนสร้างหรือตั้งค่าโปรเจกต์
5. สร้าง/นำเข้าโปรเจกต์ ตรวจโค้ดก่อนให้ Trust แล้วทดสอบ Start, SQL และ backup/restore

รุ่น QA มีป้ายบอกในหน้าจอ และใช้ executable, โฟลเดอร์ข้อมูล และพื้นที่เก็บ credentials
แยกจากแอปปกติ ต้องเก็บตัวติดตั้งกับโฟลเดอร์ออฟไลน์ที่มาคู่กันไว้เสมอ
ชุดนี้ยังไม่ได้ลงลายเซ็นเพื่อเผยแพร่สาธารณะหรือ notarize บน macOS และไม่รวม
dependencies ของ npm/Composer หรือ prerequisite ของ Linux ทุกแพ็กเกจ
ดู [รายละเอียดชุด QA](QA_DESKTOP.md) และผลทดสอบแต่ละระบบในรายงานสถานะ

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
และเก็บรหัสผ่านใน Windows Credential Manager, macOS Keychain หรือ Linux Secret Service
โดยส่งค่าการเชื่อมต่อให้ process ผ่าน environment
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
