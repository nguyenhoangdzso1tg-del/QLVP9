# Tối ưu Firestore — Quản lí vi phạm

Tài liệu này ghi lại các thay đổi giúp ứng dụng chạy trong **hạn mức miễn phí (Spark)** của Firestore, và hướng dẫn **tạo TTL policy** để dữ liệu vi phạm tự hết hạn sau 30 ngày.

---

## 0. Mục tiêu

- Giảm tối đa lượt đọc Firestore (nguyên nhân chính gây quá hạn mức).
- Giữ đủ các chức năng: nhập vi phạm, danh sách + lọc + xuất Excel, lịch vi phạm, quản lí sinh viên, Admin xóa/hoàn tác.
- Tự động dọn dữ liệu cũ bằng TTL, không cần thao tác tay mỗi tháng.
- Không thay đổi cách host trên GitHub Pages.

---

## 1. Những thay đổi chính

### 1.1. Nhập vi phạm (`index.html`, `sendfirebase.js`)

- Ghi theo lô 400 bản ghi/lần (giới hạn Firestore là 500 thao tác/lô).
- Mỗi vi phạm mới có thêm trường `expireAt` = thời điểm hiện tại + **30 ngày**.
  - Đây là trường TTL sẽ dùng để tự xóa document.
  - Sửa số ngày giữ dữ liệu tại hằng số `RETENTION_DAYS` trong `sendfirebase.js`.
- Cây Khoa → Khóa → Lớp đọc từ **1 document** `meta/studentTree` thay vì quét toàn bộ `students`.
- Tìm kiếm sinh viên: ưu tiên tìm theo tiền tố (prefix), chỉ tải sâu khi cần.
- Bật cache IndexedDB (`persistentLocalCache`) trong `firebase.js`:
  - F5 / chuyển trang không đọc lại Firestore nếu dữ liệu chưa thay đổi.

### 1.2. Danh sách vi phạm (`danhsach.html`, `list.js`)

- Phân trang **20 bản ghi/trang** ngay trên Firestore (server-side).
- **Không** chạy query đếm tổng (`getCountFromServer`) — tránh lỗi 429 / quá hạn mức.
- Lọc theo ngày chỉ đọc đúng ngày đó.
- Xuất Excel: chỉ tải toàn bộ khi người dùng bấm xuất, có cache 5 phút.
- Xóa từng bản ghi có **Hoàn tác (Undo)**; xóa nhiều bản ghi theo lựa chọn.
- Admin xóa cả tháng khi cần.
- Nút **Làm mới** tải lại 20 bản ghi mới nhất.

### 1.3. Quản lí sinh viên (`student-data.js`, `quanly-sv.html`)

- Đọc cây lớp từ `meta/studentTree` (1 lượt đọc), cache 24 giờ.
- Chỉ tải danh sách sinh viên của lớp khi mở lớp.
- Tìm kiếm theo tiền tố, có debounce.
- Chỉ tải toàn bộ khi Admin bấm nút tải tất cả.
- Thêm/sửa sinh viên cập nhật luôn cây lớp; có nút **Cập nhật lại cây lớp / khóa**.

### 1.4. Lịch vi phạm (`calendar.html`, `script.js`)

- Truy vấn theo đúng **cơ sở + ngày**, dùng index sẵn có.
- Phân trang 1.000 bản ghi/lần khi một ngày có quá nhiều dữ liệu.
- Cache dữ liệu từng ngày trong RAM + localStorage **10 phút**.
- Chỉ tải những ngày chưa có cache; bấm qua lại không tốn lượt đọc.
- Nút **Làm mới dữ liệu** xóa cache và tải lại các ngày đang chọn.
- **Bảng “Chi tiết vi phạm”**:
  - Gộp sáng + chiều của cùng một sinh viên trong cùng một ngày.
  - Có thêm cột **Người nhập**.
  - Gộp theo **sinh viên + ngày + người nhập**:
    - Cùng người nhập → 1 dòng, cộng dồn các lỗi.
    - Khác người nhập → tách thành nhiều dòng, mỗi dòng 1 người nhập.
- **Bảng “Bảng gộp vi phạm”**: gộp theo sinh viên cho tất cả các ngày đang chọn.

### 1.5. Dữ liệu và TTL

- Vi phạm mới có `expireAt` → Firestore TTL tự xóa sau 30 ngày.
- Bản ghi cũ **chưa có** `expireAt` sẽ **không** bị TTL xóa.
  - Có thể dọn bằng chức năng Admin → **Xóa cả tháng**.
- Không dùng query đếm, không quét toàn bộ collection khi mở trang.

---

## 2. Index Firestore (đã có — không cần tạo thêm)

Ứng dụng chỉ dùng 2 composite index sau, và chúng **đã tồn tại** trong project:

| Collection   | Các trường                              |
| ------------ | --------------------------------------- |
| `violations` | `coso` ASC, `createdAt` DESC, `__name__` ASC |
| `violations` | `coso` ASC, `ngay` ASC, `__name__` ASC  |

File `firestore.indexes.json` được để sẵn để tham khảo hoặc triển khai bằng Firebase CLI, nhưng **không bắt buộc** vì index đã có trên Console.

---

## 3. Firestore Rules (giữ nguyên)

Rules hiện tại đang cho phép đọc/ghi tự do:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

- `meta/studentTree` là document bình thường → không cần rule mới.
- Trường `expireAt` cũng là trường bình thường → không cần rule mới.
- **Không cần sửa Rules** khi bật TTL.

---

## 4. Tạo TTL policy (hướng dẫn chi tiết)

> TTL (Time-To-Live) là tính năng của Firestore: document có trường timestamp đã qua thời điểm đó sẽ bị xóa tự động.

### Bước 1 — Mở Firebase Console

1. Truy cập <https://console.firebase.google.com/>.
2. Chọn project **`fir-7ab56`**.

### Bước 2 — Vào Firestore Database

1. Ở menu trái, chọn **Build → Firestore Database**.
2. Chọn đúng database đang dùng (thường là `(default)`).

### Bước 3 — Mở tab TTL

1. Trong Firestore, nhìn hàng tab phía trên: **Data | Rules | Indexes | Usage | Backups | TTL**.
2. Bấm tab **TTL**.
   - Nếu không thấy tab TTL: dùng thanh tìm kiếm của Console gõ `TTL`, hoặc mở trực tiếp đường dẫn:
     `https://console.firebase.google.com/project/fir-7ab56/firestore/databases/-default-/ttl`

### Bước 4 — Tạo policy

1. Bấm **Create policy** (Tạo chính sách).
2. Điền:
   - **Collection group**: `violations`
     - Chọn đúng kiểu **Collection group** (không phải Collection).
     - Gõ chính xác chữ thường: `violations`.
   - **Timestamp field**: `expireAt`
     - Gõ chính xác, phân biệt chữ hoa/thường.
3. Bấm **Create** (Tạo).

### Bước 5 — Chờ policy hoạt động

- Trạng thái ban đầu có thể là **Creating / Đang tạo**.
- Firestore có thể mất **tới 24 giờ** để TTL bắt đầu chạy.
- Khi trạng thái là **Active / Đang hoạt động** là xong.

### Bước 6 — Kiểm tra

- Sau khi policy Active, document nào có `expireAt` **nhỏ hơn thời điểm hiện tại** sẽ bị xóa.
- Firestore không xóa đúng từng giây: thường trong vòng **24 giờ** sau khi hết hạn.
- Xóa do TTL **không bị tính** vào hạn mức thao tác xóa.

### Lưu ý quan trọng

- `expireAt` **phải là kiểu Timestamp** của Firestore (không phải chuỗi, không phải số).
- Document **không có** trường `expireAt` sẽ **không bao giờ** bị TTL xóa.
- TTL chỉ áp dụng cho dữ liệu **ghi từ sau khi cập nhật code** (có `expireAt`).
- Nếu muốn đổi số ngày lưu dữ liệu: sửa `RETENTION_DAYS` trong `sendfirebase.js` rồi deploy lại.

---

## 5. Dọn dữ liệu cũ (chưa có `expireAt`)

Dữ liệu nhập trước khi bật TTL không có trường `expireAt`, nên TTL sẽ bỏ qua.

Cách dọn:

1. Vào trang **Danh sách vi phạm**.
2. Đăng nhập **Admin**.
3. Chọn tháng cần xóa → bấm **Xóa cả tháng**.
4. Lặp lại cho các tháng cũ không còn cần dùng.

> Nên xóa vào đầu ngày (giờ Việt Nam) để tránh chạm hạn mức trong ngày.

---

## 6. Triển khai lên GitHub Pages

1. Commit / upload các file đã sửa lên repository.
2. `service-worker.js` đã được tăng phiên bản cache (hiện là **v17**).
3. Sau khi deploy, người dùng nên:
   - Đóng hết tab cũ rồi mở lại, hoặc
   - Vào **DevTools → Application → Service Workers → Update**, hoặc
   - Ctrl + F5 (Windows) / Cmd + Shift + R (Mac).

---

## 7. Mẹo giữ mức dùng trong hạn mức miễn phí

- Không bấm **Chọn cả tháng** trên lịch nếu không thực sự cần (mỗi ngày = 1 lượt truy vấn).
- Dùng nút **Làm mới** chỉ khi dữ liệu vừa thay đổi.
- Hạn mức đọc miễn phí của Firestore là **50.000 lượt/ngày**; hạn mức reset vào khoảng **14:00–15:00 giờ Việt Nam**.
- Nếu gặp lỗi `429 / Quota exceeded`: chờ sang ngày mới rồi thử lại.
- TTL giúp collection `violations` không phình to, nhờ đó truy vấn nhanh và ít tốn đọc hơn.
