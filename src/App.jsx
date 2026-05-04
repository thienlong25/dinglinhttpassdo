import React, { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "./firebase";

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
  const getModeFromPath = () => {
    const path = window.location.pathname.toLowerCase();

    if (path.startsWith("/admin")) return "admin";
    if (path.startsWith("/payment")) return "payment";

    return "shop";
  };

  const [mode, setMode] = useState(getModeFromPath);

  function goTo(path) {
    window.history.pushState({}, "", path);
    setMode(getModeFromPath());
  }

  useEffect(() => {
    const handlePopState = () => setMode(getModeFromPath());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [pin, setPin] = useState("");

  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
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

  useEffect(() => {
    const unsubProducts = onSnapshot(
      collection(db, "products"),
      (snapshot) => {
        const list = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        list.sort((a, b) => {
          const aTime = Number(a.createdAt || 0);
          const bTime = Number(b.createdAt || 0);
          if (aTime !== bTime) return bTime - aTime;
          return String(a.idCode || "").localeCompare(String(b.idCode || ""));
        });
        setProducts(list);
      },
      (error) => {
        console.error("Lỗi đọc products:", error);
        showMessage("Không đọc được sản phẩm từ Firebase.");
      }
    );

    const unsubOrders = onSnapshot(
      collection(db, "orders"),
      (snapshot) => {
        const list = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        list.sort((a, b) => Number(b.createdAt || b.closedAt || 0) - Number(a.createdAt || a.closedAt || 0));
        setOrders(list);
      },
      (error) => {
        console.error("Lỗi đọc orders:", error);
        showMessage("Không đọc được đơn hàng từ Firebase.");
      }
    );

    const unsubSettings = onSnapshot(
      doc(db, "settings", "main"),
      (snapshot) => {
        if (snapshot.exists()) {
          setSettings({ paymentMinutes: DEFAULT_PAYMENT_MINUTES, ...snapshot.data() });
        } else {
          setSettings({ paymentMinutes: DEFAULT_PAYMENT_MINUTES });
        }
      },
      (error) => {
        console.error("Lỗi đọc settings:", error);
      }
    );

    return () => {
      unsubProducts();
      unsubOrders();
      unsubSettings();
    };
  }, []);

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

  async function handleBuy(product) {
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
    const isFirstOrderForBuyer = !orders.some(
      (order) =>
        normalizePhone(order.buyerPhone) === normalizedBuyerPhone &&
        ["paid", "waiting_confirm", "pending_payment"].includes(order.status)
    );
    const shippingFee = isFirstOrderForBuyer ? FIRST_ORDER_SHIPPING_FEE : 0;
    const amount = Number(product.price || 0) + shippingFee;
    const orderId = String(Date.now()).slice(-6) + "-" + product.idCode;
    const expiresInMs = Math.max(1, Number(settings.paymentMinutes || DEFAULT_PAYMENT_MINUTES)) * 60 * 1000;
    const newOrder = {
      id: orderId,
      productId: product.id,
      productCode: product.idCode,
      productPrice: Number(product.price || 0),
      shippingFee,
      amount,
      status: "pending_payment",
      buyerIg: buyerIg.trim(),
      buyerFullName: buyerFullName.trim(),
      buyerPhone: normalizedBuyerPhone,
      buyerOldAddress: buyerOldAddress.trim(),
      createdAt: Date.now(),
      expiredAt: Date.now() + expiresInMs,
      packed: false,
    };

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, "orders", orderId), newOrder);
      batch.update(doc(db, "products", product.id), {
        status: "reserved",
        reservedUntil: newOrder.expiredAt,
        updatedAt: Date.now(),
      });
      await batch.commit();

      setSelectedOrderId(orderId);
      goTo("/payment");
      showMessage(
        isFirstOrderForBuyer
          ? "Đơn đầu tiên đã cộng 20.000đ phí ship."
          : "Đã giữ sản phẩm, vui lòng chuyển khoản trong thời gian hiển thị."
      );
    } catch (error) {
      console.error("Lỗi tạo đơn:", error);
      showMessage("Không tạo được đơn. Hãy kiểm tra Firebase/Vercel.");
    }
  }

  function handleDownloadQr(order) {
    if (!order) return;
    const url = createVietQrUrl(order);
    const link = document.createElement("a");
    link.href = url;
    link.download = createQrFileName(order);
    link.target = "_blank";
    document.body.appendChild(link);
    link.click();
    link.remove();
    showMessage("Đang tải mã QR. Nếu trình duyệt không tải, hãy giữ ảnh QR để lưu.");
  }

  async function handleConfirmTransferred(order) {
    try {
      await updateDoc(doc(db, "orders", order.id), {
        status: "waiting_confirm",
        transferredAt: Date.now(),
        updatedAt: Date.now(),
      });
      showMessage("Đã báo shop kiểm tra chuyển khoản.");
    } catch (error) {
      console.error("Lỗi báo đã chuyển khoản:", error);
      showMessage("Không cập nhật được trạng thái chuyển khoản.");
    }
  }

  async function handleConfirmPaid(order) {
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, "orders", order.id), {
        status: "paid",
        closedAt: Date.now(),
        packed: Boolean(order.packed),
        updatedAt: Date.now(),
      });
      batch.update(doc(db, "products", order.productId), {
        status: "sold",
        closedAt: Date.now(),
        updatedAt: Date.now(),
      });
      await batch.commit();
      showMessage("Đã xác nhận nhận tiền và chốt đơn.");
    } catch (error) {
      console.error("Lỗi xác nhận đơn:", error);
      showMessage("Không xác nhận được đơn.");
    }
  }

  async function handleCancelOrder(order) {
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, "orders", order.id), {
        status: "cancelled",
        cancelledAt: Date.now(),
        updatedAt: Date.now(),
      });
      batch.update(doc(db, "products", order.productId), {
        status: "available",
        reservedUntil: null,
        updatedAt: Date.now(),
      });
      await batch.commit();

      if (selectedOrderId === order.id) setSelectedOrderId("");
      showMessage("Đã hủy đơn và mở lại sản phẩm.");
    } catch (error) {
      console.error("Lỗi hủy đơn:", error);
      showMessage("Không hủy được đơn.");
    }
  }

  useEffect(() => {
    const expiredOrders = orders.filter(
      (order) => ["pending_payment", "waiting_confirm"].includes(order.status) && order.expiredAt && order.expiredAt <= now
    );
    if (!expiredOrders.length) return;

    const markExpired = async () => {
      const batch = writeBatch(db);
      expiredOrders.forEach((order) => {
        batch.update(doc(db, "orders", order.id), {
          status: "expired",
          expiredAt: order.expiredAt,
          updatedAt: Date.now(),
        });

        const product = products.find((item) => item.id === order.productId);
        if (product && product.status === "reserved") {
          batch.update(doc(db, "products", order.productId), {
            status: "available",
            reservedUntil: null,
            updatedAt: Date.now(),
          });
        }
      });

      await batch.commit();
    };

    markExpired().catch((error) => {
      console.error("Lỗi cập nhật đơn hết hạn:", error);
    });
  }, [now, orders, products]);

  async function handleAddProduct(event) {
    event.preventDefault();
    const idCode = productForm.idCode.trim().toUpperCase();
    const rawPrice = Number(productForm.price || 0);
    const price = rawPrice * 1000;
    if (!idCode || !rawPrice) {
      showMessage("Nhập ID và giá sản phẩm.");
      return;
    }
    const duplicate = products.some((item) => item.idCode.toLowerCase() === idCode.toLowerCase() && item.id !== productForm.editingId);
    if (duplicate) {
      showMessage("ID sản phẩm đã tồn tại.");
      return;
    }

    try {
      if (productForm.editingId) {
        const batch = writeBatch(db);
        batch.update(doc(db, "products", productForm.editingId), {
          idCode,
          price,
          updatedAt: Date.now(),
        });

        orders
          .filter((order) => order.productId === productForm.editingId)
          .forEach((order) => {
            batch.update(doc(db, "orders", order.id), {
              productCode: idCode,
              productPrice: price,
              amount: price + Number(order.shippingFee || 0),
              updatedAt: Date.now(),
            });
          });

        await batch.commit();
        showMessage("Đã sửa sản phẩm.");
      } else {
        const productId = createId();
        await setDoc(doc(db, "products", productId), {
          id: productId,
          idCode,
          price,
          status: "available",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        showMessage("Đã thêm sản phẩm.");
      }

      setProductForm({ idCode: "", price: "", editingId: "" });
    } catch (error) {
      console.error("Lỗi lưu sản phẩm:", error);
      showMessage("Không lưu được sản phẩm vào Firebase.");
    }
  }

  function handleEditProduct(product) {
    setProductForm({ idCode: product.idCode, price: String(Math.round(Number(product.price || 0) / 1000)), editingId: product.id });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEditProduct() {
    setProductForm({ idCode: "", price: "", editingId: "" });
  }

  function handleDeleteProduct(product) {
    setDeleteTarget(product);
  }

  async function confirmDeleteProduct() {
    if (!deleteTarget) return;
    const product = deleteTarget;

    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "products", product.id));

      orders
        .filter((order) => order.productId === product.id && ["pending_payment", "waiting_confirm"].includes(order.status))
        .forEach((order) => {
          batch.update(doc(db, "orders", order.id), {
            status: "cancelled",
            cancelledAt: Date.now(),
            updatedAt: Date.now(),
          });
        });

      await batch.commit();
      setDeleteTarget(null);
      showMessage("Đã xóa sản phẩm.");
    } catch (error) {
      console.error("Lỗi xóa sản phẩm:", error);
      showMessage("Không xóa được sản phẩm.");
    }
  }

  async function handleSetProductStatus(product, status) {
    try {
      if (status === "available") {
        const batch = writeBatch(db);
        batch.update(doc(db, "products", product.id), {
          status: "available",
          reservedUntil: null,
          closedAt: null,
          updatedAt: Date.now(),
        });

        orders
          .filter((order) => order.productId === product.id && ["pending_payment", "waiting_confirm"].includes(order.status))
          .forEach((order) => {
            batch.update(doc(db, "orders", order.id), {
              status: "cancelled",
              cancelledAt: Date.now(),
              updatedAt: Date.now(),
            });
          });

        await batch.commit();
        showMessage("Đã mở lại sản phẩm. Trang khách sẽ thấy sản phẩm này.");
        return;
      }

      if (status === "sold") {
        const manualOrderId = "MANUAL-" + String(Date.now()).slice(-6);
        const manualOrder = {
          id: manualOrderId,
          productId: product.id,
          productCode: product.idCode,
          productPrice: Number(product.price || 0),
          shippingFee: 0,
          amount: Number(product.price || 0),
          status: "paid",
          packed: false,
          isManualSold: true,
          buyerIg: "",
          buyerFullName: "",
          buyerPhone: "",
          buyerOldAddress: "",
          createdAt: Date.now(),
          closedAt: Date.now(),
        };

        const batch = writeBatch(db);
        batch.set(doc(db, "orders", manualOrderId), manualOrder);
        batch.update(doc(db, "products", product.id), {
          status: "sold",
          closedAt: Date.now(),
          updatedAt: Date.now(),
        });
        await batch.commit();

        showMessage("Đã chuyển sản phẩm sang đã bán. Trang khách sẽ ẩn sản phẩm này.");
      }
    } catch (error) {
      console.error("Lỗi đổi trạng thái sản phẩm:", error);
      showMessage("Không đổi được trạng thái sản phẩm.");
    }
  }

  async function handleUpdatePaymentMinutes(value) {
    const minutes = Math.max(1, Math.min(30, Number(value || 1)));
    setSettings({ paymentMinutes: minutes });

    try {
      await setDoc(
        doc(db, "settings", "main"),
        {
          paymentMinutes: minutes,
          updatedAt: Date.now(),
        },
        { merge: true }
      );
    } catch (error) {
      console.error("Lỗi lưu thời gian thanh toán:", error);
      showMessage("Không lưu được thời gian thanh toán.");
    }
  }

  async function handleTogglePackedByPhone(phone, packed) {
    try {
      const batch = writeBatch(db);
      orders
        .filter((order) => order.status === "paid" && normalizePhone(order.buyerPhone) === phone)
        .forEach((order) => {
          batch.update(doc(db, "orders", order.id), {
            packed,
            updatedAt: Date.now(),
          });
        });

      await batch.commit();
      showMessage(packed ? "Đã đánh dấu đóng hàng." : "Đã chuyển về chưa đóng hàng.");
    } catch (error) {
      console.error("Lỗi cập nhật đóng hàng:", error);
      showMessage("Không cập nhật được trạng thái đóng hàng.");
    }
  }

  const activeOrders = orders.filter((order) => ["pending_payment", "waiting_confirm"].includes(order.status));
  const closedOrders = orders.filter((order) => order.status === "paid");

  return (
    <div className="app">
      <style>{`
        :root { --blue: #B3EBF2; --dark: #0f172a; --muted: #64748b; --line: #d9eef2; --bg: #f8fdff; --danger: #ef4444; --success: #16a34a; }
        * { box-sizing: border-box; }
        body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--dark); }
        button, input, textarea, a { font: inherit; }
        a { color: inherit; text-decoration: none; }
        .app { min-height: 100vh; padding: 14px; }
        .shell { max-width: 1180px; margin: 0 auto; }
        .header { background: white; border: 1px solid var(--line); border-radius: 24px; padding: 14px; box-shadow: 0 12px 30px rgba(15, 23, 42, .06); margin-bottom: 14px; }
        .title { display:flex; align-items:center; gap:10px; }
        .logo { width:48px; height:48px; border-radius:16px; background: var(--blue); display:grid; place-items:center; font-weight:900; }
        h1 { font-size: 24px; margin:0; }
        h2 { font-size: 18px; margin:0 0 10px; }
        .muted { color: var(--muted); font-size: 13px; margin: 4px 0; }
        .row { display:flex; align-items:center; gap:8px; }
        .between { display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .tabs { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
        .btn { border:0; background: var(--blue); color: #0f172a; border-radius: 14px; padding: 10px 14px; font-weight: 800; cursor:pointer; transition: .15s; }
        .btn:hover { transform: translateY(-1px); filter: brightness(.99); }
        .btn.secondary { background:#eefaff; border:1px solid var(--line); }
        .btn.danger { background:#fee2e2; color:#991b1b; }
        .btn.success { background:#dcfce7; color:#166534; }
        .btn.small { padding: 7px 10px; border-radius: 12px; font-size: 13px; }
        .card { background:white; border:1px solid var(--line); border-radius: 22px; padding: 14px; box-shadow: 0 10px 24px rgba(15, 23, 42, .05); }
        .form-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; }
        .input { width:100%; border:1px solid var(--blue); border-radius: 14px; padding: 12px 12px; outline:none; background:white; }
        .input:focus { box-shadow: 0 0 0 4px rgba(179,235,242,.35); }
        .field-error { color:#dc2626; font-size:12px; margin:4px 0 0; }
        .grid-products { display:grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap:12px; }
        .product-card { position:relative; min-height: 172px; display:flex; flex-direction:column; justify-content:space-between; }
        .product-code { font-size: 30px; font-weight: 950; letter-spacing:.5px; margin:6px 0; }
        .status { display:inline-flex; align-items:center; justify-content:center; border-radius:999px; padding:5px 9px; font-size:12px; font-weight:900; white-space:nowrap; }
        .status.available { background:#dcfce7; color:#166534; }
        .status.reserved { background:#fef9c3; color:#854d0e; }
        .status.waiting { background:#e0e7ff; color:#3730a3; }
        .status.sold { background:#e2e8f0; color:#475569; }
        .status.danger { background:#fee2e2; color:#991b1b; }
        .search-box { position:relative; flex:1; min-width: 220px; }
        .search-box svg { position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#64748b; width:18px; height:18px; pointer-events:none; }
        .search-input { padding-left: 38px; }
        .payment-layout { display:grid; grid-template-columns: minmax(260px, 1fr) minmax(260px, 390px); gap:14px; align-items:start; }
        .qr-wrap { text-align:center; background:#fff; border:1px solid var(--line); border-radius:22px; padding:10px; }
        .qr-wrap img { max-width:100%; width:320px; aspect-ratio:1/1; object-fit:contain; }
        .payment-info { display:grid; gap:8px; }
        .info-line { display:flex; justify-content:space-between; gap:8px; border-bottom:1px dashed #dbeafe; padding:7px 0; font-size:14px; }
        .toast { position:fixed; z-index:50; left:50%; top:18px; transform:translateX(-50%); background:#0f172a; color:white; border-radius:999px; padding:10px 14px; box-shadow:0 14px 32px rgba(15,23,42,.24); font-weight:800; max-width: calc(100vw - 24px); text-align:center; }
        .modal-backdrop { position:fixed; inset:0; background:rgba(15,23,42,.42); z-index:60; display:grid; place-items:center; padding:16px; }
        .modal { background:white; border-radius:24px; padding:16px; max-width:420px; width:100%; box-shadow:0 20px 60px rgba(15,23,42,.25); }
        .compact-setting { display:grid; grid-template-columns: auto 80px auto; gap:8px; align-items:center; margin-bottom:12px; }
        .packing-list { display:grid; gap:12px; }
        .packing-products { display:grid; gap:8px; }
        @media (max-width: 850px) { .admin-grid { grid-template-columns: 1fr !important; } .form-grid { grid-template-columns: 1fr !important; } .customer-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } .between { align-items: flex-start; } }
        @media (max-width: 720px) { .app { padding:10px; } .header { border-radius:20px; } h1 { font-size:20px; } .grid-products { grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; } .product-code { font-size:26px; } .payment-layout { grid-template-columns: 1fr; } .qr-wrap { order:-1; } .tabs .btn { flex:1; } }
      `}</style>

      {toast && <div className="toast">{toast}</div>}
      {deleteTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Xác nhận xóa</h2>
            <p>Bạn chắc chắn muốn xóa sản phẩm <b>{deleteTarget.idCode}</b>?</p>
            <p className="muted">Nếu sản phẩm đang có đơn chờ, đơn đó sẽ bị hủy.</p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn secondary" onClick={() => setDeleteTarget(null)}>Không xóa</button>
              <button className="btn danger" onClick={confirmDeleteProduct}>Xóa</button>
            </div>
          </div>
        </div>
      )}

      <div className="shell">
        <header className="header">
          <div className="between">
            <div className="title">
              <div className="logo">ĐL</div>
              <div>
                <h1>Đinh Linh pass đồ</h1>
                <p className="muted">Chốt đơn theo ID sản phẩm · QR MB tự động · Admin đóng hàng</p>
              </div>
            </div>
            {adminUnlocked && <button className="btn secondary small" onClick={logoutAdmin}>Thoát admin</button>}
          </div>
          <div className="tabs">
            {mode === "admin" && (
              <>
                <button className="btn secondary" onClick={() => goTo("/")}>Trang khách</button>
                <button className="btn secondary" onClick={() => goTo("/payment")}>Thanh toán</button>
              </>
            )}

            {mode === "payment" && (
              <button className="btn secondary" onClick={() => goTo("/")}>Trang khách</button>
            )}
          </div>
        </header>

        {mode === "shop" && (
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
            products={products}
            now={now}
            closedOrders={closedOrders}
            showClosedOrders={showClosedOrders}
            setShowClosedOrders={setShowClosedOrders}
            handleBuy={handleBuy}
          />
        )}

        {mode === "payment" && (
          <PaymentView
            activeOrders={activeOrders}
            selectedOrder={selectedOrder}
            selectedOrderId={selectedOrderId}
            setSelectedOrderId={setSelectedOrderId}
            now={now}
            handleDownloadQr={handleDownloadQr}
            handleConfirmTransferred={handleConfirmTransferred}
          />
        )}

        {mode === "admin" && (
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
            handleDeleteProduct={handleDeleteProduct}
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
        )}
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
  );
}

function ShopView({ buyerIg, setBuyerIg, buyerFullName, setBuyerFullName, buyerPhone, setBuyerPhone, buyerOldAddress, setBuyerOldAddress, phoneError, addressError, showBuyerForm, setShowBuyerForm, search, setSearch, products, now, closedOrders, showClosedOrders, setShowClosedOrders, handleBuy }) {
  const [visibleProductCount, setVisibleProductCount] = useState(6);
  const keyword = search.trim().toLowerCase();

  const visibleAvailableProducts = useMemo(() => {
    return products
      .filter((product) => product.status === "available")
      .filter((product) => !keyword || String(product.idCode || "").toLowerCase().includes(keyword))
      .sort((a, b) =>
        String(a.idCode || "").localeCompare(String(b.idCode || ""), "vi", {
          numeric: true,
          sensitivity: "base",
        })
      );
  }, [products, keyword]);

  const productsToShow = visibleAvailableProducts.slice(0, visibleProductCount);
  const hasMoreProducts = visibleProductCount < visibleAvailableProducts.length;

  useEffect(() => {
    setVisibleProductCount(6);
  }, [keyword, products.length]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="card">
        <button className="between" style={{ width: "100%", border: 0, background: "transparent", padding: 0, textAlign: "left" }} onClick={() => setShowBuyerForm((value) => !value)}>
          <div>
            <h2 style={{ marginBottom: 3 }}>Thông tin khách</h2>
            <p className="muted">Tên IG, họ tên, SĐT và địa chỉ cũ sẽ dùng cho đơn hàng.</p>
          </div>
          <span className="status available">{showBuyerForm ? "Ẩn" : "Nhập"}</span>
        </button>
        {showBuyerForm && (
          <div className="form-grid customer-form-grid" style={{ marginTop: 12 }}>
            <div>
              <input className="input" value={buyerIg} onChange={(event) => setBuyerIg(event.target.value)} placeholder="Tên IG" />
            </div>
            <div>
              <input className="input" value={buyerFullName} onChange={(event) => setBuyerFullName(event.target.value)} placeholder="Họ tên" />
            </div>
            <div>
              <input className="input" value={buyerPhone} onChange={(event) => setBuyerPhone(event.target.value)} placeholder="SĐT" inputMode="tel" />
              {phoneError && <p className="field-error">{phoneError}</p>}
            </div>
            <div>
              <input className="input" value={buyerOldAddress} onChange={(event) => setBuyerOldAddress(event.target.value)} placeholder="Địa chỉ (Cũ)" />
              <p className="muted" style={{ margin: "5px 0 0", fontSize: 12, color: "#0369a1", fontWeight: 700 }}>Nhập chính xác địa chỉ cũ, không viết tắt</p>
              {addressError && <p className="field-error">{addressError}</p>}
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <p className="muted" style={{ margin: "0 0 10px" }}>Tìm theo ID sản phẩm rồi bấm mua. Đơn đầu tiên của mỗi SĐT tự cộng 20.000đ ship.</p>

        <div className="row" style={{ marginBottom: 12 }}>
          <div className="search-box">
            <SearchIcon />
            <input className="input search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm ID sản phẩm, ví dụ A001..." />
          </div>
          {search && <button className="btn secondary small" onClick={() => setSearch("")}>Xóa</button>}
        </div>

        <div className="closed-orders-block" style={{ marginBottom: 12 }}>
          <button className="between" style={{ width: "100%", border: 0, background: "#f0fdf4", borderRadius: 16, padding: 10, textAlign: "left" }} onClick={() => setShowClosedOrders((value) => !value)}>
            <div style={{ minWidth: 0 }}>
              <b>Đơn đã chốt: {closedOrders.length}</b>
              <p className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{closedOrders.length ? closedOrders.slice(0, 5).map((order) => order.productCode).join(" · ") : "Chưa có đơn nào"}</p>
            </div>
            <span className="status available">{showClosedOrders ? "Ẩn chi tiết" : "Xem chi tiết"}</span>
          </button>
          {showClosedOrders && (
            <div style={{ marginTop: 10 }}>
              {closedOrders.map((order) => (
                <div key={order.id} className="between" style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 16, padding: 10, marginBottom: 8 }}>
                  <div>
                    <b>ID: {order.productCode}</b>
                    <p className="muted">{order.isManualSold ? "Đã bán" : `${order.buyerIg} · ${order.buyerPhone}`}</p>
                  </div>
                  <span className="status available">Đã chốt</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid-products">
          {productsToShow.map((product) => (
            <article key={product.id} className="card product-card">
              <div>
                <p className="muted" style={{ margin: 0, fontWeight: 800 }}>ID sản phẩm</p>
                <div className="product-code">{product.idCode}</div>
                <b>{money(product.price)}</b>
              </div>
              <button className="btn" style={{ width: "100%", marginTop: 12 }} onClick={() => handleBuy(product)}>Mua</button>
            </article>
          ))}
        </div>

        {!visibleAvailableProducts.length && (
          <p className="muted" style={{ textAlign: "center", marginTop: 12 }}>Không có sản phẩm phù hợp.</p>
        )}

        {hasMoreProducts && (
          <button className="btn secondary" style={{ width: "100%", marginTop: 12 }} onClick={() => setVisibleProductCount((count) => count + 6)}>
            Xem thêm
          </button>
        )}
      </section>
    </div>
  );
}

function PaymentView({ activeOrders, selectedOrder, selectedOrderId, setSelectedOrderId, now, handleDownloadQr, handleConfirmTransferred }) {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="card">
        <h2>Chọn đơn thanh toán</h2>
        {activeOrders.length === 0 ? (
          <p className="muted">Chưa có đơn đang chờ thanh toán.</p>
        ) : (
          <div className="row" style={{ flexWrap: "wrap" }}>
            {activeOrders.map((order) => (
              <button key={order.id} className={selectedOrderId === order.id ? "btn" : "btn secondary"} onClick={() => setSelectedOrderId(order.id)}>
                {order.productCode} · {money(order.amount)}
              </button>
            ))}
          </div>
        )}
      </section>

      {selectedOrder ? (
        <section className="payment-layout">
          <div className="card" style={{ padding: 12 }}>
            <h2 style={{ marginBottom: 8 }}>Thông tin đơn hàng</h2>
            <div className="payment-info">
              <div className="info-line"><span>Mã đơn</span><b>{selectedOrder.id}</b></div>
              <div className="info-line"><span>ID sản phẩm</span><b>{selectedOrder.productCode}</b></div>
              <div className="info-line"><span>Giá sản phẩm</span><b>{money(selectedOrder.productPrice)}</b></div>
              <div className="info-line"><span>Phí ship</span><b>{money(selectedOrder.shippingFee)}</b></div>
              {Number(selectedOrder.shippingFee || 0) > 0 && <p className="muted" style={{ margin: "0 0 4px", color: "#0369a1", fontWeight: 800 }}>Đây là đơn đầu tiên của khách hàng nên hệ thống tự cộng 20.000đ phí ship.</p>}
              <div className="info-line" style={{ fontSize: 17 }}><span>Tổng cần chuyển</span><b>{money(selectedOrder.amount)}</b></div>
              <div className="info-line"><span>Nội dung CK</span><b>{createTransferContent(selectedOrder)}</b></div>
              <div className="info-line"><span>Thời gian còn lại</span><b>{countdown(Math.ceil(((selectedOrder.expiredAt || now) - now) / 1000))}</b></div>
            </div>
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <button className="btn success" onClick={() => handleConfirmTransferred(selectedOrder)}>Tôi đã chuyển khoản</button>
              <button className="btn secondary" onClick={() => handleDownloadQr(selectedOrder)}>Tải mã QR</button>
            </div>
          </div>
          <div className="qr-wrap">
            <img src={createVietQrUrl(selectedOrder)} alt="Mã QR chuyển khoản" />
            <p className="muted">QR có nội dung gồm mã đơn/ID sản phẩm và SĐT. Ảnh QR đã lưu vẫn còn quét được, nhưng đơn trên web hết thời gian thì shop có thể không giữ hàng.</p>
          </div>
        </section>
      ) : (
        <section className="card"><p className="muted">Hãy chọn một đơn đang chờ để xem QR.</p></section>
      )}
    </div>
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