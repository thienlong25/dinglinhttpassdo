import React, { useEffect, useMemo, useState } from "react";

const BANK_CONFIG = Object.freeze({
  id: "MB",
  account: "170420026868",
  owner: "DINH THI THUY LINH",
});

const DEFAULT_PAYMENT_MINUTES = 2;
const FIRST_ORDER_SHIPPING_FEE = 20000;

function money(value) {
  return new Intl.NumberFormat("vi-VN").format(Number(value || 0)) + "đ";
}

function countdown(totalSeconds) {
  const safeTotal = Math.max(0, Number(totalSeconds || 0));
  const minutes = String(Math.floor(safeTotal / 60)).padStart(2, "0");
  const seconds = String(safeTotal % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function normalizePhone(phone) {
  const raw = String(phone || "").trim();
  if (raw.startsWith("+84")) return "0" + raw.slice(3);
  if (raw.startsWith("84")) return "0" + raw.slice(2);
  return raw.replace(/\s/g, "");
}

function phoneValidationMessage(phone) {
  if (!phone) return "";
  const normalized = normalizePhone(phone);
  if (!/^0\d{9}$/.test(normalized)) return "SĐT phải gồm 10 số và bắt đầu bằng 0.";
  return "";
}

function addressValidationMessage(address) {
  if (!address) return "";
  if (address.trim().length < 8) return "Địa chỉ cũ nên nhập rõ hơn.";
  return "";
}

function statusLabel(status) {
  const map = {
    available: "Còn hàng",
    reserved: "Đang giữ",
    pending_payment: "Chờ chuyển khoản",
    waiting_confirm: "Chờ shop xác nhận",
    paid: "Đã chốt",
    packed: "Đã đóng hàng",
    unpacked: "Chưa đóng hàng",
    sold: "Đã bán",
    reopened: "Đã mở lại",
    expired: "Hết hạn",
    cancelled: "Đã hủy",
  };
  return map[status] || status;
}

function statusClass(status) {
  const cls = {
    available: "status available",
    reserved: "status reserved",
    pending_payment: "status reserved",
    waiting_confirm: "status waiting",
    paid: "status available",
    packed: "status available",
    unpacked: "status waiting",
    sold: "status sold",
    reopened: "status available",
    expired: "status danger",
    cancelled: "status danger",
  };
  return cls[status] || "status";
}

function getDisplayProductStatus(product) {
  if (product.status === "available") return "available";
  if (product.status === "reserved") return "reserved";
  if (product.status === "sold") return "sold";
  return product.status || "available";
}

function createTransferContent(order) {
  return `${order.productCode || ""} ${order.buyerPhone || ""}`.trim();
}

function createQrFileName(order) {
  const productCode = String(order.productCode || "san-pham").replace(/[^a-zA-Z0-9_-]/g, "");
  const phone = String(order.buyerPhone || "").replace(/[^0-9]/g, "");
  return `QR-${productCode}-${phone || "khach"}.png`;
}

function createVietQrUrl(order) {
  const amount = Number(order.amount || 0);
  const content = encodeURIComponent(createTransferContent(order));
  const accountName = encodeURIComponent(BANK_CONFIG.owner);
  return `https://img.vietqr.io/image/${BANK_CONFIG.id}-${BANK_CONFIG.account}-compact2.png?amount=${amount}&addInfo=${content}&accountName=${accountName}`;
}

function createId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
}

const demoProducts = [
  { id: "p1", idCode: "A001", price: 120000, status: "available" },
  { id: "p2", idCode: "A002", price: 99000, status: "reserved", reservedUntil: Date.now() + 87000 },
  { id: "p3", idCode: "A003", price: 150000, status: "sold", closedAt: Date.now() - 3600000 },
  { id: "p4", idCode: "B011", price: 180000, status: "available" },
  { id: "p5", idCode: "B012", price: 135000, status: "available" },
  { id: "p6", idCode: "C020", price: 210000, status: "available" },
];

const demoOrders = [
  {
    id: "DEMO001",
    productId: "p2",
    productCode: "A002",
    productPrice: 99000,
    shippingFee: 0,
    amount: 99000,
    status: "waiting_confirm",
    buyerIg: "linh.passdo",
    buyerFullName: "Nguyễn Mai Linh",
    buyerPhone: "0981234567",
    buyerOldAddress: "12 Trần Hưng Đạo, Hoàn Kiếm, Hà Nội",
    expiredAt: Date.now() + 87000,
  },
  {
    id: "DEMO000",
    productId: "p3",
    productCode: "A003",
    productPrice: 150000,
    shippingFee: 20000,
    amount: 170000,
    status: "paid",
    packed: false,
    buyerIg: "khach.demo",
    buyerFullName: "Khách Demo",
    buyerPhone: "0912345678",
    buyerOldAddress: "Hà Nội",
    closedAt: Date.now() - 3600000,
  },
];

export default function App() {
  const [mode, setMode] = useState("shop");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [pin, setPin] = useState("");

  const [products, setProducts] = useState(demoProducts);
  const [orders, setOrders] = useState(demoOrders);
  const [settings, setSettings] = useState({ paymentMinutes: DEFAULT_PAYMENT_MINUTES });

  const [buyerIg, setBuyerIg] = useState("");
  const [buyerFullName, setBuyerFullName] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [buyerOldAddress, setBuyerOldAddress] = useState("");
  const [showBuyerForm, setShowBuyerForm] = useState(true);

  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [search, setSearch] = useState("");
  const [productForm, setProductForm] = useState({ idCode: "", price: "", editingId: "" });
  const [adminProductSearch, setAdminProductSearch] = useState("");
  const [showClosedOrders, setShowClosedOrders] = useState(false);
  const [showAdminClosedOrders, setShowAdminClosedOrders] = useState(false);
  const [adminScreen, setAdminScreen] = useState("main");
  const [toast, setToast] = useState("");
  const [now, setNow] = useState(Date.now());
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedOrder = orders.find((order) => order.id === selectedOrderId) || null;
  const phoneError = phoneValidationMessage(buyerPhone);
  const addressError = addressValidationMessage(buyerOldAddress);

  function showMessage(message) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  function loginAdmin() {
    if (pin === "123456") {
      setAdminUnlocked(true);
      showMessage("Đã vào admin.");
    } else {
      showMessage("Sai mã admin. Mã demo là 123456.");
    }
  }

  function logoutAdmin() {
    setAdminUnlocked(false);
    setPin("");
    setAdminScreen("main");
  }

  function handleBuy(product) {
    if (!buyerIg.trim() || !buyerFullName.trim() || !buyerPhone.trim() || !buyerOldAddress.trim()) {
      showMessage("Nhập đủ Tên IG, Họ Tên, SĐT và Địa chỉ (Cũ) trước khi mua.");
      return;
    }
    if (phoneError) {
      showMessage(phoneError);
      return;
    }
    if (addressError) {
      showMessage(addressError);
      return;
    }
    if (product.status !== "available") {
      showMessage("Sản phẩm này hiện không còn để mua.");
      return;
    }

    const normalizedBuyerPhone = normalizePhone(buyerPhone);
    const hasPreviousOrder = orders.some((order) =>
      normalizePhone(order.buyerPhone) === normalizedBuyerPhone && !["cancelled", "expired", "reopened"].includes(order.status)
    );
    const shippingFee = hasPreviousOrder ? 0 : FIRST_ORDER_SHIPPING_FEE;

    const order = {
      id: "DH" + Date.now().toString().slice(-8),
      productId: product.id,
      productCode: product.idCode,
      productPrice: product.price,
      shippingFee,
      amount: product.price + shippingFee,
      status: "pending_payment",
      packed: false,
      buyerIg,
      buyerFullName,
      buyerPhone: normalizedBuyerPhone,
      buyerOldAddress,
      expiredAt: Date.now() + settings.paymentMinutes * 60 * 1000,
      createdAt: Date.now(),
    };

    setOrders((list) => [order, ...list]);
    setProducts((list) => list.map((item) => item.id === product.id ? { ...item, status: "reserved", reservedUntil: order.expiredAt } : item));
    setSelectedOrderId(order.id);
    setMode("checkout");
    showMessage(`Đã mua, vui lòng chuyển khoản trong ${settings.paymentMinutes} phút.`);
  }

  function handleReportPaid() {
    if (!selectedOrder) return;
    setOrders((list) => list.map((order) => order.id === selectedOrder.id ? { ...order, status: "waiting_confirm" } : order));
    showMessage("Đã báo chuyển khoản. Shop sẽ kiểm tra.");
  }

  function handleConfirmPaid(order) {
    setOrders((list) => list.map((item) => item.id === order.id ? { ...item, status: "paid", packed: Boolean(item.packed), closedAt: Date.now() } : item));
    setProducts((list) => list.map((item) => item.id === order.productId ? { ...item, status: "sold", closedAt: Date.now(), reservedUntil: null } : item));
    showMessage("Đã xác nhận đơn.");
  }

  function handleCancelOrder(order) {
    setOrders((list) => list.map((item) => item.id === order.id ? { ...item, status: "cancelled" } : item));
    setProducts((list) => list.map((item) => item.id === order.productId ? { ...item, status: "available", reservedUntil: null } : item));
    showMessage("Đã hủy đơn.");
  }

  function getProductFormPrice() {
    const rawPrice = Number(productForm.price || 0);
    return rawPrice * 1000;
  }

  function handleAddProduct(event) {
    event.preventDefault();
    const idCode = productForm.idCode.trim().toUpperCase();
    const finalPrice = getProductFormPrice();

    if (!idCode || !productForm.price) {
      showMessage("Nhập ID và giá sản phẩm.");
      return;
    }

    const isDuplicate = products.some((product) =>
      String(product.idCode || "").trim().toUpperCase() === idCode && product.id !== productForm.editingId
    );
    if (isDuplicate) {
      showMessage(`ID ${idCode} đã tồn tại, không thể nhập trùng.`);
      return;
    }

    if (productForm.editingId) {
      setProducts((list) => list.map((product) => product.id === productForm.editingId ? { ...product, idCode, price: finalPrice } : product));
      setProductForm({ idCode: "", price: "", editingId: "" });
      showMessage(`Đã sửa sản phẩm ${idCode}.`);
      return;
    }

    setProducts((list) => [{ id: createId(), idCode, price: finalPrice, status: "available" }, ...list]);
    setProductForm({ idCode: "", price: "", editingId: "" });
    showMessage("Đã thêm sản phẩm.");
  }

  function handleEditProduct(product) {
    setProductForm({ idCode: product.idCode || "", price: String(Math.round(Number(product.price || 0) / 1000)), editingId: product.id });
    window.scrollTo({ top: 0, behavior: "smooth" });
    showMessage(`Đang sửa sản phẩm ${product.idCode}.`);
  }

  function cancelEditProduct() {
    setProductForm({ idCode: "", price: "", editingId: "" });
  }

  function requestDeleteProduct(product) {
    setDeleteTarget(product);
  }

  function cancelDeleteProduct() {
    setDeleteTarget(null);
  }

  function confirmDeleteProduct() {
    if (!deleteTarget) return;
    setProducts((list) => list.filter((item) => item.id !== deleteTarget.id));
    setOrders((list) => list.map((order) => order.productId === deleteTarget.id ? { ...order, status: "cancelled" } : order));
    setDeleteTarget(null);
    showMessage(`Đã xóa sản phẩm ${deleteTarget.idCode}.`);
  }

  function handleTogglePackedByPhone(phone, packed) {
    const normalizedPhone = normalizePhone(phone);
    setOrders((list) => list.map((order) => (
      order.status === "paid" && normalizePhone(order.buyerPhone) === normalizedPhone
        ? { ...order, packed: Boolean(packed), packedAt: packed ? Date.now() : null }
        : order
    )));
    showMessage(packed ? "Đã chuyển sang trạng thái đã đóng hàng." : "Đã chuyển sang trạng thái chưa đóng hàng.");
  }

  function handleSetProductStatus(product, status) {
    const isReopening = status === "available" && product.status === "sold";

    setProducts((list) => list.map((item) => item.id === product.id ? {
      ...item,
      status,
      reservedUntil: status === "available" ? null : item.reservedUntil,
      closedAt: status === "sold" ? Date.now() : status === "available" ? null : item.closedAt,
    } : item));

    if (isReopening) {
      setOrders((list) => list.map((order) => (
        order.status === "paid" && (order.productId === product.id || order.productCode === product.idCode)
          ? { ...order, status: "reopened", reopenedAt: Date.now() }
          : order
      )));
      showMessage(`Đã mở lại sản phẩm ${product.idCode}. Sản phẩm đã được gỡ khỏi danh sách đã chốt.`);
      return;
    }

    showMessage("Đã đổi trạng thái.");
  }

  function handleUpdatePaymentMinutes(value) {
    const minutes = Math.min(30, Math.max(1, Number(value || 1)));
    setSettings({ paymentMinutes: minutes });
  }

  async function downloadQr(order) {
    const qrUrl = createVietQrUrl(order);
    const fileName = createQrFileName(order);

    try {
      const response = await fetch(qrUrl, { mode: "cors" });
      if (!response.ok) throw new Error("Không tải được ảnh QR");

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      showMessage("Đã tải mã QR.");
    } catch (error) {
      const link = document.createElement("a");
      link.href = qrUrl;
      link.download = fileName;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
      showMessage("Nếu trình duyệt chỉ mở ảnh QR, hãy giữ vào ảnh rồi chọn Lưu ảnh.");
    }
  }

  const visibleProducts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return products
      .filter((product) => product.status !== "hidden")
      .filter((product) => !keyword || String(product.idCode || "").toLowerCase().includes(keyword));
  }, [products, search]);

  const closedOrders = useMemo(() => {
    const paidOrders = orders.filter((order) => order.status === "paid");
    const paidProductCodes = new Set(paidOrders.map((order) => order.productCode));
    const manualSold = products
      .filter((product) => product.status === "sold" && !paidProductCodes.has(product.idCode))
      .map((product) => ({
        id: `sold-${product.id}`,
        productId: product.id,
        productCode: product.idCode,
        productPrice: product.price,
        shippingFee: 0,
        amount: product.price,
        status: "paid",
        packed: false,
        buyerIg: "",
        buyerFullName: "",
        buyerPhone: "",
        buyerOldAddress: "",
        closedAt: product.closedAt || null,
        isManualSold: true,
      }));
    return [...paidOrders, ...manualSold];
  }, [orders, products]);

  const activeOrders = orders.filter((order) => ["pending_payment", "waiting_confirm"].includes(order.status));

  return (
    <div className="min-h-screen bg-[#f7fbfc] text-slate-900">
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; font-family: Arial, Helvetica, sans-serif; }
        button, input { font: inherit; }
        .page { max-width: 1100px; margin: 0 auto; padding: 14px; }
        .card { background: white; border: 1px solid #d9eef2; border-radius: 22px; padding: 14px; box-shadow: 0 8px 30px rgba(31, 80, 90, 0.07); }
        .btn { border: 0; background: #B3EBF2; color: #102b30; padding: 11px 13px; border-radius: 14px; cursor: pointer; font-weight: 800; }
        .btn:disabled { opacity: .45; cursor: not-allowed; }
        .btn.secondary { background: #edf8fa; }
        .btn.success { background: #dcfce7; color: #166534; }
        .btn.danger { background: #ffe3e3; color: #991b1b; }
        .btn.small { padding: 7px 9px; border-radius: 10px; font-size: 12px; font-weight: 900; }
        .input { width: 100%; border: 1px solid #B3EBF2; border-radius: 14px; padding: 12px; outline: none; background: white; }
        .input.error { border-color: #fca5a5; background: #fff1f2; }
        .search-box { position: relative; flex: 1; }
        .search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; color: #64748b; pointer-events: none; }
        .search-input { padding-left: 38px; }
        .grid-products { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
        @media (min-width: 850px) { .grid-products { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
        @media (max-width: 850px) { .admin-grid { grid-template-columns: 1fr !important; } .form-grid { grid-template-columns: 1fr !important; } .between { align-items: flex-start; } }
        .product { min-height: 180px; display: flex; flex-direction: column; gap: 12px; }
        .status { display: inline-flex; width: fit-content; padding: 5px 9px; border-radius: 999px; font-size: 12px; font-weight: 900; background: #f1f5f9; color: #475569; }
        .status.available { background: #eafaf0; color: #16a34a; }
        .status.reserved { background: #fff7e6; color: #f59e0b; }
        .status.waiting { background: #eef2ff; color: #4f46e5; }
        .status.sold { background: #f1f5f9; color: #64748b; }
        .status.danger { background: #ffecec; color: #ef4444; }
        .toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: #12252a; color: white; border-radius: 999px; padding: 10px 16px; z-index: 999; box-shadow: 0 8px 30px rgba(0,0,0,.18); }
        .row { display: flex; gap: 10px; align-items: center; }
        .between { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
        .muted { color: #64748b; font-size: 13px; }
        .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
        .scroll-top-btn { position: fixed; right: 16px; bottom: 18px; width: 46px; height: 46px; border: 0; border-radius: 999px; background: #B3EBF2; color: #102b30; font-size: 24px; font-weight: 900; cursor: pointer; z-index: 998; box-shadow: 0 8px 24px rgba(31, 80, 90, 0.18); }
        .scroll-top-btn:active { transform: scale(0.96); }
        .compact-setting { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #ecfeff; border: 1px solid #cffafe; border-radius: 16px; padding: 8px 10px; margin-bottom: 12px; }
        .compact-setting label { flex: 1; margin: 0; font-weight: 800; }
        .compact-setting input { width: 74px; padding: 8px; text-align: center; }
        .modal-backdrop { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(15, 23, 42, 0.42); z-index: 1000; padding: 18px; }
        .confirm-modal { width: min(390px, 100%); background: white; border-radius: 22px; padding: 18px; box-shadow: 0 22px 60px rgba(15, 23, 42, 0.25); }
        .confirm-modal h3 { margin: 0 0 8px; }
        .confirm-modal p { margin: 0 0 6px; line-height: 1.45; }
        .packing-list { display: grid; gap: 12px; }
        .packing-products { display: grid; gap: 8px; }
      `}</style>

      {toast && <div className="toast">{toast}</div>}

      <main className="page">
        <header className="between" style={{ marginBottom: 14, alignItems: "flex-start" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 25 }}>Đinh Linh pass đồ</h1>
            <p className="muted" style={{ margin: "4px 0 0" }}>Sản phẩm chỉ hiển thị ID và giá.</p>
          </div>
          <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button className="btn secondary" onClick={() => setMode("shop")}>Trang khách</button>
            <button className="btn secondary" onClick={() => setMode("admin")}>Admin</button>
            {mode === "admin" && adminUnlocked && <button className="btn secondary" onClick={logoutAdmin}>Thoát</button>}
          </div>
        </header>

        {mode === "admin" ? (
          <AdminView
            adminUnlocked={adminUnlocked}
            pin={pin}
            setPin={setPin}
            loginAdmin={loginAdmin}
            products={products}
            activeOrders={activeOrders}
            closedOrders={closedOrders}
            showAdminClosedOrders={showAdminClosedOrders}
            setShowAdminClosedOrders={setShowAdminClosedOrders}
            productForm={productForm}
            setProductForm={setProductForm}
            handleAddProduct={handleAddProduct}
            handleDeleteProduct={requestDeleteProduct}
            handleEditProduct={handleEditProduct}
            cancelEditProduct={cancelEditProduct}
            handleSetProductStatus={handleSetProductStatus}
            handleConfirmPaid={handleConfirmPaid}
            handleCancelOrder={handleCancelOrder}
            settings={settings}
            handleUpdatePaymentMinutes={handleUpdatePaymentMinutes}
            adminProductSearch={adminProductSearch}
            setAdminProductSearch={setAdminProductSearch}
            adminScreen={adminScreen}
            setAdminScreen={setAdminScreen}
            handleTogglePackedByPhone={handleTogglePackedByPhone}
          />
        ) : mode === "checkout" && selectedOrder ? (
          <CheckoutView order={selectedOrder} now={now} onReportPaid={handleReportPaid} onBackHome={() => setMode("shop")} downloadQr={downloadQr} />
        ) : (
          <ShopView
            buyerIg={buyerIg}
            setBuyerIg={setBuyerIg}
            buyerFullName={buyerFullName}
            setBuyerFullName={setBuyerFullName}
            buyerPhone={buyerPhone}
            setBuyerPhone={setBuyerPhone}
            buyerOldAddress={buyerOldAddress}
            setBuyerOldAddress={setBuyerOldAddress}
            phoneError={phoneError}
            addressError={addressError}
            showBuyerForm={showBuyerForm}
            setShowBuyerForm={setShowBuyerForm}
            search={search}
            setSearch={setSearch}
            products={visibleProducts}
            now={now}
            closedOrders={closedOrders}
            showClosedOrders={showClosedOrders}
            setShowClosedOrders={setShowClosedOrders}
            handleBuy={handleBuy}
          />
        )}
      </main>

      {deleteTarget && (
        <div className="modal-backdrop" onClick={cancelDeleteProduct}>
          <div className="confirm-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Xóa sản phẩm?</h3>
            <p>Bạn có chắc chắn muốn xóa sản phẩm <b>{deleteTarget.idCode}</b> không?</p>
            <p className="muted">Thao tác này sẽ xóa sản phẩm khỏi danh sách và hủy đơn đang liên quan.</p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn secondary" onClick={cancelDeleteProduct}>Hủy</button>
              <button className="btn danger" onClick={confirmDeleteProduct}>Xóa</button>
            </div>
          </div>
        </div>
      )}

      <button className="scroll-top-btn" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="Lên đầu trang" title="Lên đầu trang">↑</button>
    </div>
  );
}

function ShopView({ buyerIg, setBuyerIg, buyerFullName, setBuyerFullName, buyerPhone, setBuyerPhone, buyerOldAddress, setBuyerOldAddress, phoneError, addressError, showBuyerForm, setShowBuyerForm, search, setSearch, products, now, closedOrders, showClosedOrders, setShowClosedOrders, handleBuy }) {
  return (
    <>
      <section className="card" style={{ marginBottom: 12 }}>
        <button className="between" style={{ width: "100%", border: 0, background: "transparent", padding: 0, textAlign: "left" }} onClick={() => setShowBuyerForm((value) => !value)}>
          <div style={{ minWidth: 0 }}>
            <b>Thông tin người mua</b>
            <p className="muted" style={{ margin: "3px 0 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{buyerIg || "Tên IG"} · {buyerFullName || "Họ Tên"} · {buyerPhone || "SĐT"}</p>
          </div>
          <span className="status">{showBuyerForm ? "Thu gọn" : "Sửa"}</span>
        </button>

        {showBuyerForm && (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label className="muted">Tên IG<input className="input" value={buyerIg} onChange={(event) => setBuyerIg(event.target.value)} placeholder="Tên IG" /></label>
            <label className="muted">Họ Tên<input className="input" value={buyerFullName} onChange={(event) => setBuyerFullName(event.target.value)} placeholder="Họ tên" /></label>
            <label className="muted">SĐT<input className={`input ${phoneError ? "error" : ""}`} value={buyerPhone} onChange={(event) => setBuyerPhone(event.target.value)} placeholder="0981234567" inputMode="tel" />{phoneError && <span style={{ color: "#dc2626", fontSize: 12 }}>{phoneError}</span>}</label>
            <label className="muted">Địa chỉ (Cũ)<input className={`input ${addressError ? "error" : ""}`} value={buyerOldAddress} onChange={(event) => setBuyerOldAddress(event.target.value)} placeholder="Địa chỉ cũ" /><span style={{ color: "#d97706", fontSize: 12, fontWeight: 700 }}>Lưu ý nhập đúng địa chỉ cũ, không viết tắt</span>{addressError && <span style={{ color: "#dc2626", fontSize: 12, display: "block" }}>{addressError}</span>}</label>
          </div>
        )}
      </section>

      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "#f7fbfc", padding: "8px 0", marginBottom: 10 }}>
        <div className="row">
          <div className="search-box">
            <SearchIcon />
            <input className="input search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm ID sản phẩm, ví dụ A001..." />
          </div>
          {search && <button className="btn secondary" onClick={() => setSearch("")}>Xóa</button>}
        </div>
      </div>

      <section className="card" style={{ padding: 10, marginBottom: 12 }}>
        <button className="between" style={{ width: "100%", border: 0, background: "transparent", padding: 0, textAlign: "left" }} onClick={() => setShowClosedOrders((value) => !value)}>
          <div style={{ minWidth: 0 }}>
            <b>Đơn đã chốt: {closedOrders.length}</b>
            <p className="muted" style={{ margin: "3px 0 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{closedOrders.length ? closedOrders.slice(0, 5).map((order) => order.productCode).join(" · ") : "Chưa có đơn nào"}</p>
          </div>
          <span className="status available">{showClosedOrders ? "Ẩn" : "Xem"}</span>
        </button>
        {showClosedOrders && closedOrders.length > 0 && (
          <div className="row" style={{ marginTop: 10, overflowX: "auto", alignItems: "stretch" }}>
            {closedOrders.map((order) => (
              <div key={order.id} style={{ minWidth: 120, border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 14, padding: 10 }}>
                <b>{order.productCode}</b>
                <p style={{ margin: "3px 0", fontSize: 12 }}>{money(order.amount)}</p>
                <p className="muted" style={{ margin: 0, fontSize: 11 }}>Đã bán</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid-products">
        {products.map((product) => {
          const displayStatus = getDisplayProductStatus(product);
          const left = Math.max(0, Math.ceil(((product.reservedUntil || 0) - now) / 1000));
          return (
            <article key={product.id} className="card product">
              <div style={{ background: "#ecfeff", border: "1px solid #cffafe", borderRadius: 18, padding: 14, textAlign: "center" }}>
                <p className="muted" style={{ margin: 0, fontWeight: 800 }}>ID sản phẩm</p>
                <h2 style={{ margin: "4px 0 0", fontSize: 28 }}>{product.idCode}</h2>
              </div>
              <div style={{ textAlign: "center" }}>
                <p style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 900 }}>{money(product.price)}</p>
                <span className={statusClass(displayStatus)}>{statusLabel(displayStatus)} {displayStatus === "reserved" && left > 0 ? `- ${countdown(left)}` : ""}</span>
              </div>
              <button className="btn" disabled={displayStatus !== "available"} onClick={() => handleBuy(product)} style={{ marginTop: "auto" }}>Mua</button>
            </article>
          );
        })}
      </section>
    </>
  );
}

function CheckoutView({ order, now, onReportPaid, onBackHome, downloadQr }) {
  const [qrLoaded, setQrLoaded] = useState(false);
  const qrUrl = useMemo(() => createVietQrUrl(order), [order.id, order.amount, order.productCode, order.buyerPhone]);
  const left = Math.max(0, Math.ceil(((order.expiredAt || 0) - now) / 1000));
  const productPrice = Number(order.productPrice || order.amount || 0);
  const shippingFee = Number(order.shippingFee || 0);

  useEffect(() => {
    setQrLoaded(false);
  }, [qrUrl]);

  return (
    <section className="card" style={{ maxWidth: 680, margin: "0 auto" }}>
      <div style={{ background: "#ecfeff", border: "1px solid #cffafe", borderRadius: 16, padding: 10, marginBottom: 12 }} className="between">
        <div><p className="muted" style={{ margin: 0, fontWeight: 800 }}>Mã đơn: {order.id}</p><b>{order.productCode} · {money(order.amount)}</b></div>
        <span className={statusClass(order.status === "pending_payment" ? "reserved" : order.status)}>{statusLabel(order.status)}</span>
      </div>
      {order.status === "pending_payment" && (
        <>
          <div style={{ border: "2px solid #bae6fd", borderRadius: 24, padding: 14, textAlign: "center" }}>
            <div className="between" style={{ background: "#ecfeff", borderRadius: 16, padding: 10, marginBottom: 12 }}><b>Quét QR để chuyển khoản</b><span style={{ background: "white", borderRadius: 999, padding: "6px 12px", fontWeight: 900, fontSize: 18 }}>{countdown(left)}</span></div>
            {!qrLoaded && (
              <div style={{ width: 330, maxWidth: "100%", minHeight: 330, margin: "0 auto", borderRadius: 18, border: "1px dashed #67e8f9", background: "#f0fdff", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
                <p className="muted" style={{ margin: 0, fontWeight: 800 }}>Đang tải mã QR...</p>
              </div>
            )}
            <img src={qrUrl} alt="QR chuyển khoản" loading="eager" decoding="async" onLoad={() => setQrLoaded(true)} style={{ width: 330, maxWidth: "100%", borderRadius: 18, border: "1px solid #cffafe", display: qrLoaded ? "inline-block" : "none" }} />
            <p className="muted">QR tự điền số tiền và nội dung chuyển khoản.</p>
            {shippingFee > 0 && (
              <p style={{ background: "#fff7ed", color: "#c2410c", borderRadius: 14, padding: "9px 10px", fontSize: 13, fontWeight: 800, margin: "8px 0" }}>
                Đơn đầu tiên của bạn được cộng thêm {money(shippingFee)} phí ship.
              </p>
            )}
            <button className="btn" style={{ width: "100%" }} onClick={() => downloadQr(order)}>Tải mã QR</button>
            <p style={{ color: "#dc2626", fontSize: 12, fontWeight: 800 }}>Lưu ý: Mã QR chỉ hợp lệ trong thời gian giữ đơn. Nếu quá giờ, vui lòng quay lại chọn lại sản phẩm trước khi chuyển khoản.</p>
          </div>
          <div style={{ border: "1px dashed #67e8f9", background: "#ecfeff", borderRadius: 18, padding: 12, marginTop: 12, fontSize: 14, lineHeight: 1.7 }}>
            <b>Thông tin chuyển khoản</b>
            <p>Ngân hàng: <b>{BANK_CONFIG.id}</b></p>
            <p>Số tài khoản: <b>{BANK_CONFIG.account}</b></p>
            <p>Chủ tài khoản: <b>{BANK_CONFIG.owner}</b></p>
            <p>Tiền sản phẩm: <b>{money(productPrice)}</b></p>
            {shippingFee > 0 && <p>Phí ship đơn đầu tiên: <b>{money(shippingFee)}</b></p>}
            <p>Tổng cần chuyển: <b>{money(order.amount)}</b></p>
            <p>Nội dung: <b>{createTransferContent(order)}</b></p>
          </div>
          <button className="btn success" style={{ width: "100%", marginTop: 12 }} disabled={left <= 0} onClick={onReportPaid}>Tôi đã chuyển khoản</button>
        </>
      )}
      {order.status === "waiting_confirm" && <ResultBox text="Bạn đã báo chuyển khoản. Shop đang kiểm tra tiền về." onBackHome={onBackHome} />}
      {order.status === "paid" && <ResultBox text="Đơn đã được shop xác nhận thanh toán." onBackHome={onBackHome} success />}
    </section>
  );
}

function ResultBox({ text, onBackHome, success, danger }) {
  return <div><div style={{ background: success ? "#dcfce7" : danger ? "#fee2e2" : "#eef2ff", color: success ? "#166534" : danger ? "#991b1b" : "#3730a3", borderRadius: 16, padding: 14, fontWeight: 800, marginBottom: 12 }}>{text}</div><button className="btn" style={{ width: "100%" }} onClick={onBackHome}>Quay về Trang chủ</button></div>;
}

function SearchIcon() {
  return (
    <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
  );
}

function groupOrdersByPhone(orders) {
  const grouped = new Map();

  orders
    .filter((order) => order.status === "paid" && !order.isManualSold)
    .forEach((order) => {
      const phone = normalizePhone(order.buyerPhone || "khong-co-sdt");
      const current = grouped.get(phone) || {
        phone,
        buyerIg: order.buyerIg || "",
        buyerFullName: order.buyerFullName || "",
        buyerOldAddress: order.buyerOldAddress || "",
        orders: [],
        totalAmount: 0,
        totalShippingFee: 0,
        packed: true,
      };

      current.buyerIg = current.buyerIg || order.buyerIg || "";
      current.buyerFullName = current.buyerFullName || order.buyerFullName || "";
      current.buyerOldAddress = current.buyerOldAddress || order.buyerOldAddress || "";
      current.orders.push(order);
      current.totalAmount += Number(order.amount || 0);
      current.totalShippingFee += Number(order.shippingFee || 0);
      current.packed = current.packed && Boolean(order.packed);
      grouped.set(phone, current);
    });

  return Array.from(grouped.values()).sort((a, b) => Number(a.packed) - Number(b.packed));
}

function AdminView({ adminUnlocked, pin, setPin, loginAdmin, products, activeOrders, closedOrders, showAdminClosedOrders, setShowAdminClosedOrders, productForm, setProductForm, handleAddProduct, handleDeleteProduct, handleEditProduct, cancelEditProduct, handleSetProductStatus, handleConfirmPaid, handleCancelOrder, settings, handleUpdatePaymentMinutes, adminProductSearch, setAdminProductSearch, adminScreen, setAdminScreen, handleTogglePackedByPhone }) {
  const adminKeyword = adminProductSearch.trim().toLowerCase();
  const adminVisibleProducts = products.filter((product) => !adminKeyword || String(product.idCode || "").toLowerCase().includes(adminKeyword));
  const packingOrders = useMemo(() => groupOrdersByPhone(closedOrders), [closedOrders]);

  if (!adminUnlocked) {
    return (
      <section className="card" style={{ maxWidth: 460, margin: "0 auto" }}>
        <h2>Admin</h2>
        <p className="muted">Nhập mã PIN để vào quản lý. Mã demo: 123456</p>
        <input className="input" type="password" value={pin} onChange={(event) => setPin(event.target.value)} placeholder="Mã admin" onKeyDown={(event) => event.key === "Enter" && loginAdmin()} />
        <button className="btn" style={{ marginTop: 10, width: "100%" }} onClick={loginAdmin}>Vào admin</button>
      </section>
    );
  }

  if (adminScreen === "packing") {
    return <PackingView packingOrders={packingOrders} onBack={() => setAdminScreen("main")} onTogglePacked={handleTogglePackedByPhone} />;
  }

  return (
    <div className="admin-grid" style={{ display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr", gap: 14 }}>
      <section className="card" style={{ height: "fit-content" }}>
        <button className="btn" style={{ width: "100%", marginBottom: 12 }} onClick={() => setAdminScreen("packing")}>Màn hình đóng hàng</button>
        <h2>{productForm.editingId ? "Sửa sản phẩm" : "Thêm sản phẩm"}</h2>
        <div className="compact-setting">
          <label className="muted">Giữ đơn</label>
          <input className="input" type="number" min="1" max="30" value={settings.paymentMinutes} onChange={(event) => handleUpdatePaymentMinutes(event.target.value)} />
          <span className="muted">phút</span>
        </div>
        <form onSubmit={handleAddProduct}>
          <input className="input" value={productForm.idCode} onChange={(event) => setProductForm({ ...productForm, idCode: event.target.value })} placeholder="ID sản phẩm: A001" />
          <div style={{ height: 10 }} />
          <input className="input" value={productForm.price} onChange={(event) => setProductForm({ ...productForm, price: event.target.value })} placeholder="Giá: nhập 120 = 120.000đ" type="number" inputMode="numeric" />
          {productForm.price && <p className="muted" style={{ margin: "6px 0 0" }}>Giá hiển thị: <b>{money(Number(productForm.price || 0) * 1000)}</b></p>}
          <button className="btn" style={{ width: "100%", marginTop: 10 }}>{productForm.editingId ? "Lưu chỉnh sửa" : "Thêm sản phẩm"}</button>
          {productForm.editingId && <button type="button" className="btn secondary" style={{ width: "100%", marginTop: 8 }} onClick={cancelEditProduct}>Hủy sửa</button>}
        </form>
      </section>

      <div style={{ display: "grid", gap: 14 }}>
        <section className="card">
          <h2>Đơn đang chờ</h2>
          {activeOrders.length === 0 ? <p className="muted">Chưa có đơn đang chờ.</p> : activeOrders.map((order) => (
            <div key={order.id} className="between" style={{ border: "1px solid #d9eef2", borderRadius: 16, padding: 12, marginBottom: 10, alignItems: "flex-start" }}>
              <div>
                <b>ID: {order.productCode}</b>
                <p className="muted">IG: {order.buyerIg} · {order.buyerFullName} · {order.buyerPhone}</p>
                <p className="muted">Địa chỉ (Cũ): {order.buyerOldAddress || "-"}</p>
                <b>{money(order.amount)}</b>
              </div>
              <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
                <span className={statusClass(order.status)}>{statusLabel(order.status)}</span>
                <button className="btn success" onClick={() => handleConfirmPaid(order)}>Đã nhận tiền</button>
                <button className="btn danger" onClick={() => handleCancelOrder(order)}>Hủy</button>
              </div>
            </div>
          ))}
        </section>

        <section className="card" style={{ padding: 10 }}>
          <button className="between" style={{ width: "100%", border: 0, background: "transparent", padding: 0, textAlign: "left" }} onClick={() => setShowAdminClosedOrders((value) => !value)}>
            <div style={{ minWidth: 0 }}>
              <b>Đơn đã chốt: {closedOrders.length}</b>
              <p className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{closedOrders.length ? closedOrders.slice(0, 6).map((order) => order.productCode).join(" · ") : "Chưa có đơn nào được chốt"}</p>
            </div>
            <span className="status available">{showAdminClosedOrders ? "Ẩn chi tiết" : "Xem chi tiết"}</span>
          </button>
          {showAdminClosedOrders && (
            <div style={{ marginTop: 10 }}>
              {closedOrders.map((order) => (
                <div key={order.id} className="between" style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 16, padding: 10, marginBottom: 8 }}>
                  <div>
                    <b>ID: {order.productCode} · {money(order.amount)}</b>
                    <p className="muted">{order.isManualSold ? "Chốt thủ công từ sản phẩm" : `${order.buyerIg} · ${order.buyerFullName} · ${order.buyerPhone}`}</p>
                    {!order.isManualSold && <p className="muted">Địa chỉ (Cũ): {order.buyerOldAddress || "-"}</p>}
                  </div>
                  <p className="muted">Đã chốt</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <h2>Sản phẩm</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="search-box">
              <SearchIcon />
              <input className="input search-input" value={adminProductSearch} onChange={(event) => setAdminProductSearch(event.target.value)} placeholder="Tìm sản phẩm trong admin, ví dụ A001..." />
            </div>
            {adminProductSearch && <button className="btn secondary small" onClick={() => setAdminProductSearch("")}>Xóa</button>}
          </div>
          <div className="grid-products">
            {adminVisibleProducts.map((product) => {
              const displayStatus = getDisplayProductStatus(product);
              return (
                <article key={product.id} className="card">
                  <p className="muted" style={{ margin: 0, fontWeight: 800 }}>ID sản phẩm</p>
                  <h3 style={{ margin: "4px 0", fontSize: 26 }}>{product.idCode}</h3>
                  <b>{money(product.price)}</b>
                  <div style={{ margin: "8px 0" }}><span className={statusClass(displayStatus)}>{statusLabel(displayStatus)}</span></div>
                  <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                    <button className="btn secondary small" onClick={() => handleEditProduct(product)}>Sửa</button>
                    <button className="btn secondary small" onClick={() => handleSetProductStatus(product, product.status === "sold" ? "available" : "sold")}>{product.status === "sold" ? "Mở" : "Đã bán"}</button>
                    {product.status !== "available" && <button className="btn secondary small" onClick={() => handleSetProductStatus(product, "available")}>Mở lại</button>}
                    <button className="btn danger small" onClick={() => handleDeleteProduct(product)}>Xóa</button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function PackingView({ packingOrders, onBack, onTogglePacked }) {
  const totalProducts = packingOrders.reduce((sum, group) => sum + group.orders.length, 0);
  const unpackedCount = packingOrders.filter((group) => !group.packed).length;

  return (
    <section className="card">
      <div className="between" style={{ marginBottom: 14, alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>Màn hình đóng hàng</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>Gộp đơn đã chốt theo cùng số điện thoại. Có {packingOrders.length} kiện hàng, {totalProducts} sản phẩm.</p>
        </div>
        <button className="btn secondary" onClick={onBack}>Quay lại admin</button>
      </div>

      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <span className="status waiting">Chưa đóng hàng: {unpackedCount}</span>
        <span className="status available">Đã đóng hàng: {packingOrders.length - unpackedCount}</span>
      </div>

      {packingOrders.length === 0 ? (
        <p className="muted">Chưa có đơn đã chốt để đóng hàng.</p>
      ) : (
        <div className="packing-list">
          {packingOrders.map((group) => (
            <article key={group.phone} className="card" style={{ boxShadow: "none", borderColor: group.packed ? "#bbf7d0" : "#c7d2fe" }}>
              <div className="between" style={{ alignItems: "flex-start", marginBottom: 10 }}>
                <div>
                  <h3 style={{ margin: "0 0 4px" }}>{group.buyerFullName || "Chưa có họ tên"}</h3>
                  <p className="muted" style={{ margin: 0 }}>IG: <b>{group.buyerIg || "-"}</b> · SĐT: <b>{group.phone}</b></p>
                </div>
                <span className={statusClass(group.packed ? "packed" : "unpacked")}>{group.packed ? "Đã đóng hàng" : "Chưa đóng hàng"}</span>
              </div>

              <div style={{ background: "#f8fafc", borderRadius: 14, padding: 10, marginBottom: 10 }}>
                <p style={{ margin: 0 }}><b>Địa chỉ (Cũ):</b> {group.buyerOldAddress || "-"}</p>
              </div>

              <div className="packing-products">
                {group.orders.map((order) => (
                  <div key={order.id} className="between" style={{ border: "1px solid #e2e8f0", borderRadius: 14, padding: 10 }}>
                    <div>
                      <b>ID sản phẩm: {order.productCode}</b>
                      <p className="muted" style={{ margin: "3px 0 0" }}>Mã đơn: {order.id}</p>
                    </div>
                    <b>{money(order.amount)}</b>
                  </div>
                ))}
              </div>

              <div className="between" style={{ marginTop: 12, alignItems: "flex-end" }}>
                <div>
                  {group.totalShippingFee > 0 && <p className="muted" style={{ margin: "0 0 4px" }}>Có phí ship: <b>{money(group.totalShippingFee)}</b></p>}
                  <p style={{ margin: 0, fontSize: 18 }}><b>Tổng tiền: {money(group.totalAmount)}</b></p>
                </div>
                <button className={group.packed ? "btn secondary" : "btn success"} onClick={() => onTogglePacked(group.phone, !group.packed)}>
                  {group.packed ? "Chuyển chưa đóng" : "Đã đóng hàng"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
