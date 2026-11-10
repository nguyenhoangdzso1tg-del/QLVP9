### 1.3. Danh sách sinh viên

- Cây Khoa → Khóa → Lớp được đọc từ document `meta/studentTree`.
- Không tự động quét toàn bộ collection `students` khi document meta chưa tồn tại.
- Admin sử dụng nút "Cập nhật lại cây lớp / khóa" để tạo hoặc cập nhật cây.
- Chỉ tải danh sách sinh viên khi người dùng mở lớp.
- Tìm kiếm sử dụng query prefix và giới hạn kết quả.
- Cache cây lớp và danh sách lớp trong 24 giờ.

### 1.4. Lịch vi phạm

- Truy vấn theo đúng cơ sở và ngày.
- Sử dụng composite index `coso ASC, ngay ASC`.
- Tự động phân trang 1.000 bản ghi/lần.
- Không dùng fallback truy vấn chỉ theo ngày.
- Cache dữ liệu theo ngày trong RAM và localStorage 10 phút.
- Nút làm mới chủ động tải lại dữ liệu.
### 1.5. Quản lý dữ liệu

- Không sử dụng bảng xếp hạng.
- Không sử dụng Firestore TTL.
- Không tự động xóa dữ liệu vi phạm.
- Admin chủ động xóa dữ liệu theo tháng khi cần.
- Dữ liệu vi phạm được giữ lại cho đến khi Admin thực hiện xóa.