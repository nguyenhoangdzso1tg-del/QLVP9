import { db } from "./firebase.js";
import {
  collection,
  doc,
  getDocs,
  query,
  orderBy,
  limit,
  where,
  startAfter,
  deleteDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

/* ===== CƠ SỞ (Chu Văn An / Mạc Cửu) — mọi truy vấn đều lọc theo cơ sở ===== */
const COSO_CVA = "Chu Văn An";
const COSO_MC = "Mạc Cửu";
const COSO = localStorage.getItem("coso") || "";
if (!COSO) window.location.href = "login.html";

/* ===== CẤU HÌNH TỐI ƯU LƯỢT ĐỌC ===== */
const PAGE_SIZE = 20;                 // mỗi lần chỉ đọc 20 bản ghi
const EXPORT_BATCH = 500;             // chỉ dùng khi người dùng bấm Xuất Excel
const EXPORT_CACHE_MS = 5 * 60 * 1000; // giữ kết quả xuất trong 5 phút

let allData = [];                     // dữ liệu của TRANG hiện tại
let lastDeleted = null;
let deleteTimeout = null;
const pendingDeletedIds = new Set();

const tbody = document.getElementById("list");

/* ===== MULTI-SELECT STATE ===== */
let isSelectMode = false;
let selectedIds = new Set();

/* ===== PHÂN TRANG PHÍA SERVER ===== */
let currentPage = 1;
let maxVisitedPage = 1;
let pageCursors = [null, null];       // pageCursors[p] = document cuối của trang p-1
let totalCount = null;
let hasMore = false;
let loading = false;

/* ===== LỌC NGÀY ===== */
let isFiltering = false;
let currentFilterDate = null;
let filteredAllCache = null;
let filteredAllCacheDate = null;
let filteredAllCacheAt = 0;

/* ===== ADMIN (xóa vi phạm) ===== */
const ADMIN_PASSWORD = "kgc2026"; // đổi mật khẩu tại đây
let isAdmin = sessionStorage.getItem("vp_admin") === "1";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function sortByCreatedDesc(a, b) {
  const ta = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
  const tb = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
  return tb - ta;
}

function getCosoLabel() {
  return COSO ? "Cơ sở " + COSO : "";
}

function applyAdminUI() {
  const btnTrash = document.getElementById("btnTrash");
  const btnAdmin = document.getElementById("btnAdmin");
  const btnOut = document.getElementById("btnAdminOut");
  const loginBox = document.getElementById("adminLoginBox");
  const monthDeleteWrap = document.getElementById("monthDeleteWrap");

  if (isAdmin) {
    if (btnTrash) btnTrash.style.display = "inline-flex";
    if (btnAdmin) btnAdmin.style.display = "none";
    if (btnOut) btnOut.style.display = "inline-flex";
    if (loginBox) loginBox.style.display = "none";
    if (monthDeleteWrap) monthDeleteWrap.style.display = "inline-flex";
  } else {
    if (btnTrash) btnTrash.style.display = "none";
    if (btnAdmin) btnAdmin.style.display = "inline-flex";
    if (btnOut) btnOut.style.display = "none";
    if (loginBox) loginBox.style.display = "none";
    if (monthDeleteWrap) monthDeleteWrap.style.display = "none";
    if (isSelectMode) exitSelectMode();
  }

  renderTable(getCurrentDisplayData());
}

function getCurrentDisplayData() {
  return allData;
}

/* ===== TẢI 1 TRANG (chỉ đọc PAGE_SIZE bản ghi) ===== */
function buildPageQuery(page) {
  const constraints = [];

  if (isFiltering && currentFilterDate) {
    // Lọc theo ngày: không orderBy để tránh cần thêm composite index.
    constraints.push(where("coso", "==", COSO));
    constraints.push(where("ngay", "==", currentFilterDate));
  } else {
    // Danh sách mới nhất: index coso + createdAt (đã dùng từ trước).
    constraints.push(where("coso", "==", COSO));
    constraints.push(orderBy("createdAt", "desc"));
  }

  if (page > 1 && pageCursors[page]) {
    constraints.push(startAfter(pageCursors[page]));
  }

  constraints.push(limit(PAGE_SIZE));
  return query(collection(db, "violations"), ...constraints);
}

async function loadPage(page = 1, { reset = false } = {}) {
  if (loading) return;

  if (reset) {
    pageCursors = [null, null];
    maxVisitedPage = 1;
    currentPage = 1;
    page = 1;
  }

  if (page < 1) page = 1;
  if (page > 1 && !pageCursors[page]) page = 1;

  loading = true;

  try {
    const snap = await getDocs(buildPageQuery(page));
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    items.sort(sortByCreatedDesc);

    allData = items.filter((v) => !pendingDeletedIds.has(v.id));

    if (snap.docs.length > 0) {
      pageCursors[page + 1] = snap.docs[snap.docs.length - 1];
    }

    hasMore = snap.docs.length === PAGE_SIZE;
    maxVisitedPage = Math.max(maxVisitedPage, page);
    currentPage = page;

    selectedIds.clear();
    updateSelectedCount();
    renderTable(allData);
    renderPagination();
  } catch (e) {
    console.error("Lỗi tải danh sách:", e);
    tbody.innerHTML = `
      <tr>
        <td colspan="12" class="empty">
          Lỗi tải dữ liệu: ${esc(e.message || e)}
        </td>
      </tr>
    `;
    alert(
      "Lỗi tải danh sách.\nNếu Firebase yêu cầu tạo index, mở link trong Console (F12) và chạy lại.\n" +
      (e.message || e)
    );
  } finally {
    loading = false;
  }
}

/* ===== HIỂN THỊ BẢNG ===== */
function renderTable(data) {
  tbody.innerHTML = "";

  const colCount = 12; // bảng luôn có 12 cột (cột checkbox vẫn giữ chỗ dù ẩn)

  if (!data || data.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${colCount}" class="empty">
          Không có vi phạm
        </td>
      </tr>
    `;
    return;
  }

  data.forEach((v) => {
    let time = "—";
    if (v.createdAt && typeof v.createdAt.toDate === "function") {
      time = v.createdAt.toDate().toLocaleString("vi-VN");
    }

    const isChecked = selectedIds.has(v.id);
    const selectCell = isSelectMode
      ? `<td class="col-select show">
           <input type="checkbox" class="select-checkbox row-checkbox" data-id="${esc(v.id)}" ${isChecked ? "checked" : ""}>
         </td>`
      : `<td class="col-select"></td>`;

    const tr = document.createElement("tr");
    if (isChecked) tr.classList.add("selected-row");

    const deleteCell = isAdmin
      ? `<td><button class="btn-delete" data-id="${esc(v.id)}">X</button></td>`
      : `<td style="color:#94a3b8;">—</td>`;

    tr.innerHTML = `
      ${selectCell}
      <td>${esc(v.maSV)}</td>
      <td>${esc(v.hoTen)}</td>
      <td>${esc(v.lop)}</td>
      <td>${esc(v.khoaHoc)}</td>
      <td>${esc(v.khoa)}</td>
      <td>${esc(v.ngay)}</td>
      <td>${esc(v.buoi)}</td>
      <td>${esc(v.vipham)}</td>
      <td>${esc(time)}</td>
      <td>${esc(v.nguoiNhap || "—")}</td>
      ${deleteCell}
    `;
    tbody.appendChild(tr);
  });

  if (isAdmin) attachDeleteEvents();
  if (isSelectMode) {
    attachSelectEvents();
    syncSelectAllCheckbox();
  }
}

/* ===== PHÂN TRANG ===== */
function renderPagination() {
  const containerBottom = document.getElementById("pagination");
  const containerTop = document.getElementById("paginationTop");
  if (!containerBottom || !containerTop) return;

  containerBottom.innerHTML = "";
  containerTop.innerHTML = "";

  const totalPages = totalCount != null
    ? Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
    : null;

  const canPrev = currentPage > 1;
  const canNext = hasMore || (totalPages != null && currentPage < totalPages);

  if (!canPrev && !canNext && totalPages == null) return;

  function createBtn(label, page, disabled) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerText = label;
    btn.disabled = !!disabled;
    btn.style.margin = "0 3px";
    if (!disabled && page) btn.onclick = () => loadPage(page);
    return btn;
  }

  function render(container) {
    if (canPrev) {
      container.appendChild(createBtn("« Đầu", 1, false));
      container.appendChild(createBtn("← Trước", currentPage - 1, false));
    }

    const info = document.createElement("span");
    info.style.margin = "0 8px";
    info.style.fontSize = "14px";
    info.textContent = totalPages != null
      ? `Trang ${currentPage}/${totalPages} (${totalCount} bản ghi)`
      : `Trang ${currentPage}`;
    container.appendChild(info);

    if (canNext) {
      container.appendChild(createBtn("Sau →", currentPage + 1, false));
    }
  }

  render(containerTop);
  render(containerBottom);
}

/* ===== SINGLE DELETE (giữ nguyên Hoàn tác) ===== */
function attachDeleteEvents() {
  document.querySelectorAll(".btn-delete").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;

      if (!confirm("Bạn có chắc muốn xóa vi phạm này?")) return;

      const item = allData.find((v) => v.id === id) || null;
      lastDeleted = item;

      // Đánh dấu "đang chờ xóa" để không bị tải lại trong lúc hiện toast Hoàn tác
      pendingDeletedIds.add(id);

      allData = allData.filter((v) => v.id !== id);
      selectedIds.delete(id);
      updateSelectedCount();

      if (totalCount != null) totalCount = Math.max(0, totalCount - 1);

      renderTable(allData);
      renderPagination();
      showUndoToast();

      clearTimeout(deleteTimeout);
      deleteTimeout = setTimeout(async () => {
        try {
          await deleteDoc(doc(db, "violations", id));
        } catch (e) {
          console.error("Lỗi xóa:", e);
          alert("Xóa thất bại. Bản ghi sẽ được tải lại.");
          if (item) {
            allData.unshift(item);
            allData.sort(sortByCreatedDesc);
            if (totalCount != null) totalCount += 1;
            renderTable(allData);
            renderPagination();
          }
        } finally {
          pendingDeletedIds.delete(id);
          if (lastDeleted && lastDeleted.id === id) lastDeleted = null;
        }
      }, 8000);
    };
  });
}

/* ===== MULTI-SELECT EVENTS ===== */
function attachSelectEvents() {
  document.querySelectorAll(".row-checkbox").forEach((cb) => {
    cb.onchange = () => {
      const id = cb.dataset.id;
      if (cb.checked) {
        selectedIds.add(id);
        cb.closest("tr").classList.add("selected-row");
      } else {
        selectedIds.delete(id);
        cb.closest("tr").classList.remove("selected-row");
      }
      updateSelectedCount();
      syncSelectAllCheckbox();
    };
  });
}

function updateSelectedCount() {
  const el = document.getElementById("selectedCount");
  if (el) el.innerText = selectedIds.size;
}

function syncSelectAllCheckbox() {
  const headerCb = document.getElementById("selectAllHeader");
  const topCb = document.getElementById("selectAll");
  const rowCbs = document.querySelectorAll(".row-checkbox");

  if (!rowCbs.length) {
    if (headerCb) headerCb.checked = false;
    if (topCb) topCb.checked = false;
    return;
  }

  const allChecked = [...rowCbs].every((cb) => cb.checked);
  if (headerCb) headerCb.checked = allChecked;
  if (topCb) topCb.checked = allChecked;
}

/* ===== LỌC THEO NGÀY (chỉ đọc 20 bản ghi/trang) ===== */
document.getElementById("btnFilter").onclick = async () => {
  const date = document.getElementById("filterDate").value;
  if (!date) {
    alert("Chọn ngày cần lọc!");
    return;
  }

  isFiltering = true;
  currentFilterDate = date;
  filteredAllCache = null;
  filteredAllCacheDate = null;
  selectedIds.clear();
  updateSelectedCount();
  updateExportButton();

  await loadPage(1, { reset: true });
};

document.getElementById("btnClear").onclick = () => {
  isFiltering = false;
  currentFilterDate = null;
  filteredAllCache = null;
  filteredAllCacheDate = null;
  document.getElementById("filterDate").value = "";
  selectedIds.clear();
  updateSelectedCount();
  updateExportButton();

  loadPage(1, { reset: true });
};

const btnRefresh = document.getElementById("btnRefresh");
if (btnRefresh) {
  btnRefresh.onclick = () => {
    filteredAllCache = null;
    filteredAllCacheDate = null;
    loadPage(1, { reset: true });
  };
}

/* ===== UNDO (single delete) ===== */
function showUndoToast() {
  const toast = document.getElementById("undoToast");
  if (!toast) return;
  toast.style.display = "block";

  setTimeout(() => {
    toast.style.display = "none";
  }, 5000);
}

window.undoDelete = function () {
  if (!lastDeleted) return;

  clearTimeout(deleteTimeout);
  pendingDeletedIds.delete(lastDeleted.id);

  allData.unshift(lastDeleted);
  allData.sort(sortByCreatedDesc);

  if (totalCount != null) totalCount += 1;

  lastDeleted = null;
  const toast = document.getElementById("undoToast");
  if (toast) toast.style.display = "none";

  renderTable(allData);
  renderPagination();
};

/* ===== MULTI DELETE UI ===== */
function enterSelectMode() {
  isSelectMode = true;
  selectedIds.clear();
  updateSelectedCount();

  document.getElementById("btnTrash").classList.add("active");
  document.getElementById("btnConfirmDelete").classList.add("show");
  document.getElementById("btnCancelSelect").classList.add("show");
  document.getElementById("selectAllWrap").classList.add("show");
  document.getElementById("thSelect").classList.add("show");
  document.querySelectorAll(".col-select").forEach((el) => el.classList.add("show"));

  renderTable(getCurrentDisplayData());
}

function exitSelectMode() {
  isSelectMode = false;
  selectedIds.clear();
  updateSelectedCount();

  document.getElementById("btnTrash").classList.remove("active");
  document.getElementById("btnConfirmDelete").classList.remove("show");
  document.getElementById("btnCancelSelect").classList.remove("show");
  document.getElementById("selectAllWrap").classList.remove("show");
  document.getElementById("thSelect").classList.remove("show");

  const headerCb = document.getElementById("selectAllHeader");
  const topCb = document.getElementById("selectAll");
  if (headerCb) headerCb.checked = false;
  if (topCb) topCb.checked = false;

  renderTable(getCurrentDisplayData());
}

document.getElementById("btnTrash").onclick = () => {
  if (isSelectMode) exitSelectMode();
  else enterSelectMode();
};

document.getElementById("btnCancelSelect").onclick = () => {
  exitSelectMode();
};

/* Chọn tất cả (header + top) */
function toggleSelectAll(checked) {
  const rowCbs = document.querySelectorAll(".row-checkbox");
  rowCbs.forEach((cb) => {
    cb.checked = checked;
    const id = cb.dataset.id;
    if (checked) {
      selectedIds.add(id);
      cb.closest("tr").classList.add("selected-row");
    } else {
      selectedIds.delete(id);
      cb.closest("tr").classList.remove("selected-row");
    }
  });
  updateSelectedCount();

  const headerCb = document.getElementById("selectAllHeader");
  const topCb = document.getElementById("selectAll");
  if (headerCb) headerCb.checked = checked;
  if (topCb) topCb.checked = checked;
}

document.getElementById("selectAllHeader").onchange = (e) => {
  toggleSelectAll(e.target.checked);
};
document.getElementById("selectAll").onchange = (e) => {
  toggleSelectAll(e.target.checked);
};

/* Xóa nhiều đã chọn — dùng writeBatch để giảm số lần gọi mạng */
document.getElementById("btnConfirmDelete").onclick = async () => {
  if (selectedIds.size === 0) {
    alert("Chưa chọn vi phạm nào!");
    return;
  }

  const count = selectedIds.size;
  if (!confirm(`Bạn có chắc muốn xóa ${count} vi phạm đã chọn?`)) return;

  const idsToDelete = [...selectedIds];
  const delSet = new Set(idsToDelete);

  allData = allData.filter((v) => !delSet.has(v.id));
  idsToDelete.forEach((id) => pendingDeletedIds.add(id));
  selectedIds.clear();
  updateSelectedCount();

  if (totalCount != null) {
    totalCount = Math.max(0, totalCount - idsToDelete.length);
  }

  renderTable(allData);
  renderPagination();

  try {
    const BATCH = 400;
    for (let i = 0; i < idsToDelete.length; i += BATCH) {
      const chunk = idsToDelete.slice(i, i + BATCH);
      const batch = writeBatch(db);
      chunk.forEach((id) => batch.delete(doc(db, "violations", id)));
      await batch.commit();
    }
  } catch (err) {
    console.error("Lỗi xóa nhiều:", err);
    alert("Có lỗi khi xóa một số bản ghi. Vui lòng bấm Làm mới.");
  } finally {
    idsToDelete.forEach((id) => pendingDeletedIds.delete(id));
  }

  exitSelectMode();
};

/* ===== XÓA TOÀN BỘ 1 THÁNG (chỉ Admin) ===== */
async function fetchMonthIds(start, end) {
  const ids = [];
  let cursor = null;

  while (true) {
    const constraints = [
      where("coso", "==", COSO),
      where("ngay", ">=", start),
      where("ngay", "<=", end)
    ];

    if (cursor) constraints.push(startAfter(cursor));
    constraints.push(limit(500));

    const snap = await getDocs(
      query(collection(db, "violations"), ...constraints)
    );

    snap.forEach((d) => ids.push(d.id));

    if (snap.docs.length < 500) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  return ids;
}

document.getElementById("btnDeleteMonth").onclick = async () => {
  const m = document.getElementById("filterMonth").value;
  if (!m) {
    alert("Chọn tháng cần xóa (ô bên cạnh), VD 2026-10!");
    return;
  }

  const [y, mo] = m.split("-").map(Number);
  const lastDay = new Date(y, mo, 0).getDate();
  const start = m + "-01";
  const end = m + "-" + String(lastDay).padStart(2, "0");

  try {
    const ids = await fetchMonthIds(start, end);

    if (ids.length === 0) {
      alert("Tháng " + m + " chưa có vi phạm nào để xóa.");
      return;
    }

    if (!confirm(
      "Xóa TOÀN BỘ " + ids.length + " vi phạm tháng " + m + "?\n\nKhông hoàn tác được!"
    )) return;

    const btn = document.getElementById("btnDeleteMonth");
    btn.disabled = true;

    try {
      const BATCH = 400;
      let done = 0;

      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        const batch = writeBatch(db);
        chunk.forEach((id) => batch.delete(doc(db, "violations", id)));
        await batch.commit();
        done += chunk.length;
      }

      alert("Đã xóa " + done + " vi phạm tháng " + m + ".");
      document.getElementById("filterMonth").value = "";

      pendingDeletedIds.clear();
      filteredAllCache = null;
      filteredAllCacheDate = null;

      await loadPage(1, { reset: true });
    } finally {
      btn.disabled = false;
    }
  } catch (e) {
    console.error(e);
    alert(
      "Lỗi xóa tháng.\nNếu Firebase yêu cầu tạo index, mở link trong Console (F12).\n" +
      (e.message || e)
    );
  }
};



/* ===== ADMIN LOGIN ===== */
document.getElementById("btnAdmin").onclick = () => {
  const box = document.getElementById("adminLoginBox");
  const show = box.style.display === "none" || box.style.display === "";
  box.style.display = show ? "block" : "none";
  document.getElementById("adminMsg").textContent = "";
  document.getElementById("adminPassword").value = "";
  if (show) document.getElementById("adminPassword").focus();
};

document.getElementById("btnAdminCancel").onclick = () => {
  document.getElementById("adminLoginBox").style.display = "none";
  document.getElementById("adminMsg").textContent = "";
};

document.getElementById("btnAdminLogin").onclick = () => {
  const pw = document.getElementById("adminPassword").value;
  if (pw === ADMIN_PASSWORD) {
    isAdmin = true;
    sessionStorage.setItem("vp_admin", "1");
    applyAdminUI();
  } else {
    document.getElementById("adminMsg").textContent = "Sai mật khẩu!";
  }
};

document.getElementById("adminPassword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btnAdminLogin").click();
});

document.getElementById("btnAdminOut").onclick = () => {
  isAdmin = false;
  sessionStorage.removeItem("vp_admin");
  applyAdminUI();
};

/* ===== XUẤT EXCEL (chỉ ngày đã lọc, không cần Admin) ===== */
function updateExportButton() {
  const btn = document.getElementById("btnExport");
  const btnSang = document.getElementById("btnExportSang");
  const btnChieu = document.getElementById("btnExportChieu");

  // Chỉ hiện khi đang lọc 1 ngày
  const shown = isFiltering && !!currentFilterDate;
  if (btn) btn.style.display = shown ? "inline-flex" : "none";
  if (btnSang) btnSang.style.display = shown ? "inline-flex" : "none";
  if (btnChieu) btnChieu.style.display = shown ? "inline-flex" : "none";
}

// Chuẩn hóa "buổi" nhập vào: Sáng/Chiều (có dấu hay không) → SANG / CHIEU
function normBuoi(b) {
  return String(b || "")
    .toUpperCase()
    .replace(/[ÁÀẢÃẠ]/g, "A")
    .replace(/[ỀẾỂỄỆ]/g, "E")
    .trim();
}

// Đóng gói 1 danh sách bản ghi thành các dòng Excel (cùng cột như bảng)
function makeExcelRows(list) {
  return list.map((v, i) => ({
    STT: i + 1,
    "Mã SV": v.maSV || "",
    "Họ tên": v.hoTen || "",
    "Lớp": v.lop || "",
    "Khóa": v.khoaHoc || "",
    "Khoa": v.khoa || "",
    "Ngày": v.ngay || "",
    "Buổi": v.buoi || "",
    "Vi phạm": v.vipham || "",
    "Thời gian nhập": (v.createdAt && v.createdAt.toDate
      ? v.createdAt.toDate().toLocaleString("vi-VN")
      : ""),
    "Người nhập": v.nguoiNhap || ""
  }));
}

// Excel: đổi ô "chữ số" thành số thật để dùng được SUM / công thức
function coerceNumericCells(ws) {
  Object.keys(ws).forEach((addr) => {
    if (addr.charAt(0) === "!") return;
    const cell = ws[addr];
    if (!cell || cell.t !== "s" || typeof cell.v !== "string") return;
    const s = cell.v.trim();
    if (/^-?\d{1,9}(\.\d+)?$/.test(s)) {
      cell.t = "n";
      cell.v = Number(s);
      delete cell.w;
    }
  });
  return ws;
}

function exportExcel(list, emptyMsg, fileNameSuffix) {
  if (!list.length) {
    alert(emptyMsg || "Không có dữ liệu để xuất!");
    return;
  }

  const rows = makeExcelRows(list);
  const columns = Object.keys(rows[0]);
  const aoa = [["Cơ sở: " + COSO], []];
  aoa.push(columns);
  rows.forEach((r) => aoa.push(columns.map((c) => r[c])));

  const ws = coerceNumericCells(XLSX.utils.aoa_to_sheet(aoa));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Vi phạm");

  const fileName =
    "vi_pham_" + COSO.replace(" ", "_") + "_" + currentFilterDate +
    (fileNameSuffix || "") + ".xlsx";

  XLSX.writeFile(wb, fileName);
}

/*
 * Chỉ tải TOÀN BỘ bản ghi của ngày đã lọc khi người dùng bấm Xuất Excel.
 * Kết quả được giữ 5 phút để bấm "Xuất buổi sáng" / "Xuất buổi chiều"
 * không phải đọc lại Firebase.
 */
async function fetchAllFiltered() {
  if (!isFiltering || !currentFilterDate) return [];

  if (
    filteredAllCache &&
    filteredAllCacheDate === currentFilterDate &&
    Date.now() - filteredAllCacheAt < EXPORT_CACHE_MS
  ) {
    return filteredAllCache;
  }

  const out = [];
  let cursor = null;

  while (true) {
    const constraints = [
      where("coso", "==", COSO),
      where("ngay", "==", currentFilterDate)
    ];

    if (cursor) constraints.push(startAfter(cursor));
    constraints.push(limit(EXPORT_BATCH));

    const snap = await getDocs(
      query(collection(db, "violations"), ...constraints)
    );

    snap.forEach((d) => out.push({ id: d.id, ...d.data() }));

    if (snap.docs.length < EXPORT_BATCH) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  out.sort(sortByCreatedDesc);
  filteredAllCache = out;
  filteredAllCacheDate = currentFilterDate;
  filteredAllCacheAt = Date.now();
  return out;
}

async function withExportButton(btn, task) {
  if (!isFiltering || !currentFilterDate) {
    alert("Hãy lọc theo 1 ngày trước khi xuất Excel!");
    return;
  }

  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Đang tải...";

  try {
    await task();
  } catch (e) {
    console.error(e);
    alert("Lỗi tải dữ liệu để xuất Excel:\n" + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

/* Xuất tất cả các bản ghi đã lọc */
document.getElementById("btnExport").onclick = () => {
  const btn = document.getElementById("btnExport");
  withExportButton(btn, async () => {
    const list = await fetchAllFiltered();
    exportExcel(list, "Ngày này không có dữ liệu để xuất!", "");
  });
};

/* Xuất chỉ các bản ghi BUỔI SÁNG đã lọc */
document.getElementById("btnExportSang").onclick = () => {
  const btn = document.getElementById("btnExportSang");
  withExportButton(btn, async () => {
    const list = await fetchAllFiltered();
    const sangOnly = list.filter((v) => normBuoi(v.buoi) === "SANG");
    exportExcel(sangOnly, "Ngày này không có vi phạm buổi sáng!", "_sang");
  });
};

/* Xuất chỉ các bản ghi BUỔI CHIỀU đã lọc */
document.getElementById("btnExportChieu").onclick = () => {
  const btn = document.getElementById("btnExportChieu");
  withExportButton(btn, async () => {
    const list = await fetchAllFiltered();
    const chieuOnly = list.filter((v) => normBuoi(v.buoi) === "CHIEU");
    exportExcel(chieuOnly, "Ngày này không có vi phạm buổi chiều!", "_chieu");
  });
};

/* ===== KHỞI ĐỘNG ===== */
applyAdminUI();
updateExportButton();
loadPage(1, { reset: true });
