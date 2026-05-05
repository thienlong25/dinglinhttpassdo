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
const CURRENT_PAYMENT_ORDER_KEY = "dinglinh_current_payment_order_id";
const CUSTOMER_INFO_KEY = "dinglinh_customer_info";

function getSavedPaymentOrderId() {
  try {
    return window.localStorage.getItem(CURRENT_PAYMENT_ORDER_KEY) || "";
  } catch {
    return "";
  }
}

function savePaymentOrderId(orderId) {
  try {
    if (orderId) window.localStorage.setItem(CURRENT_PAYMENT_ORDER_KEY, orderId);
  } catch {
    // localStorage may be unavailable in private mode.
  }
}

function clearSavedPaymentOrderId() {
  try {
    window.localStorage.removeItem(CURRENT_PAYMENT_ORDER_KEY);
  } catch {
    // localStorage may be unavailable in private mode.
  }
}

function getSavedCustomerInfo() {
  try {
    const raw = window.localStorage.getItem(CUSTOMER_INFO_KEY);
    if (!raw) return { buyerIg: "", buyerFullName: "", buyerPhone: "", buyerOldAddress: "" };
    const parsed = JSON.parse(raw);
    return {
      buyerIg: parsed.buyerIg || "",
      buyerFullName: parsed.buyerFullName || "",
      buyerPhone: parsed.buyerPhone || "",
      buyerOldAddress: parsed.buyerOldAddress || "",
    };
  } catch {
    return { buyerIg: "", buyerFullName: "", buyerPhone: "", buyerOldAddress: "" };
  }
}

function saveCustomerInfo(info) {
  try {
    window.localStorage.setItem(CUSTOMER_INFO_KEY, JSON.stringify(info));
  } catch {
    // localStorage may be unavailable in private mode.
  }
}

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
    customer_payment: "Chờ chuyển khoản",
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
    customer_payment: "status reserved",
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

  const savedCustomerInfo = useMemo(() => getSavedCustomerInfo(), []);
  const [buyerIg, setBuyerIg] = useState(savedCustomerInfo.buyerIg);
  const [buyerFullName, setBuyerFullName] = useState(savedCustomerInfo.buyerFullName);
  const [buyerPhone, setBuyerPhone] = useState(savedCustomerInfo.buyerPhone);
  const [buyerOldAddress, setBuyerOldAddress] = useState(savedCustomerInfo.buyerOldAddress);
  const [showBuyerForm, setShowBuyerForm] = useState(true);

  const [selectedOrderId, setSelectedOrderId] = useState(getSavedPaymentOrderId);
  const [search, setSearch] = useState("");
  const [productForm, setProductForm] = useState({ idCode: "", price: "", editingId: "" });
  const [adminProductSearch, setAdminProductSearch] = useState("");
  const [showClosedOrders, setShowClosedOrders] = useState(false);
  const [showAdminClosedOrders, setShowAdminClosedOrders] = useState(false);
  const [adminScreen, setAdminScreen] = useState("main");
  const [toast, setToast] = useState("");
  const [now, setNow] = useState(Date.now());
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [packingDeleteTarget, setPackingDeleteTarget] = useState(null);
  const [transferNoticeOrder, setTransferNoticeOrder] = useState(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);


  useEffect(() => {
    saveCustomerInfo({ buyerIg, buyerFullName, buyerPhone, buyerOldAddress });
  }, [buyerIg, buyerFullName, buyerPhone, buyerOldAddress]);

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
        list.sort((a, b) => String(a.idCode || "").localeCompare(String(b.idCode || ""), "vi", { numeric: true, sensitivity: "base" }));
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
    const existingPaymentOrder = orders.find(
      (order) =>
        normalizePhone(order.buyerPhone) === normalizedBuyerPhone &&
        ["customer_payment", "pending_payment"].includes(order.status) &&
        (!order.expiredAt || order.expiredAt > now)
    );

    if (existingPaymentOrder) {
      setSelectedOrderId(existingPaymentOrder.id);
      savePaymentOrderId(existingPaymentOrder.id);
      showMessage("Bạn đang có đơn cần thanh toán, hãy thanh toán hoặc hủy đơn đó để mua đơn này");
      return;
    }

    const isFirstOrderForBuyer = !orders.some(
      (order) =>
        normalizePhone(order.buyerPhone) === normalizedBuyerPhone &&
        ["paid", "waiting_confirm", "customer_payment", "pending_payment"].includes(order.status)
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
      status: "customer_payment",
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
      savePaymentOrderId(orderId);
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

  async function handleDownloadQr(order) {
    if (!order) return;
    const url = createVietQrUrl(order);
    const fileName = createQrFileName(order);

    try {
      const response = await fetch(url, { mode: "cors" });
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1200);
      showMessage("Đã lưu/tải mã QR về máy. Nếu điện thoại hỏi quyền, hãy chọn Lưu ảnh.");
    } catch (error) {
      console.error("Lỗi tải QR:", error);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.target = "_blank";
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      showMessage("Nếu QR chưa tự lưu, hãy giữ vào ảnh QR rồi chọn Lưu ảnh.");
    }
  }

  async function handleConfirmTransferred(order) {
    try {
      const batch = writeBatch(db);

      batch.update(doc(db, "orders", order.id), {
        status: "waiting_confirm",
        transferredAt: Date.now(),
        expiredAt: null,
        updatedAt: Date.now(),
      });

      if (order.productId) {
        batch.update(doc(db, "products", order.productId), {
          status: "waiting_confirm",
          reservedUntil: null,
          updatedAt: Date.now(),
        });
      }

      await batch.commit();

      if (selectedOrderId === order.id) {
        clearSavedPaymentOrderId();
      }
      setTransferNoticeOrder({ ...order, status: "waiting_confirm", expiredAt: null });
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

      if (selectedOrderId === order.id) {
        setSelectedOrderId("");
        clearSavedPaymentOrderId();
      }
      showMessage("Đã hủy đơn và mở lại sản phẩm.");
    } catch (error) {
      console.error("Lỗi hủy đơn:", error);
      showMessage("Không hủy được đơn.");
    }
  }

  useEffect(() => {
    const expiredOrders = orders.filter(
      (order) => ["customer_payment", "pending_payment"].includes(order.status) && order.expiredAt && order.expiredAt <= now
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
        .filter((order) => order.productId === product.id && ["customer_payment", "pending_payment", "waiting_confirm"].includes(order.status))
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
          .filter((order) => order.productId === product.id && ["customer_payment", "pending_payment", "waiting_confirm"].includes(order.status))
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

        showMessage("Đã chuyển sản phẩm sang đã bán. Trang khách vẫn hiển thị trạng thái Đã bán.");
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

  function requestDeletePackingOrder(order) {
    setPackingDeleteTarget({ type: "single", orders: [order] });
  }

  function requestDeleteAllPackingOrders(ordersToDelete) {
    setPackingDeleteTarget({ type: "all", orders: ordersToDelete });
  }

  async function confirmDeletePackingOrders() {
    if (!packingDeleteTarget || !packingDeleteTarget.orders?.length) return;

    try {
      const batch = writeBatch(db);
      packingDeleteTarget.orders.forEach((order) => {
        batch.delete(doc(db, "orders", order.id));
      });
      await batch.commit();

      const count = packingDeleteTarget.orders.length;
      setPackingDeleteTarget(null);
      showMessage(count > 1 ? "Đã xóa toàn bộ sản phẩm trong màn hình đóng hàng." : "Đã xóa item khỏi màn hình đóng hàng.");
    } catch (error) {
      console.error("Lỗi xóa item đóng hàng:", error);
      showMessage("Không xóa được item trong màn hình đóng hàng.");
    }
  }

  const normalizedCurrentPhone = normalizePhone(buyerPhone);
  const adminActiveOrders = orders.filter((order) => order.status === "waiting_confirm");
  const customerActiveOrders = orders.filter(
    (order) => ["customer_payment", "pending_payment"].includes(order.status) && normalizedCurrentPhone && normalizePhone(order.buyerPhone) === normalizedCurrentPhone
  );
  const closedOrders = orders.filter((order) => order.status === "paid");
  const customerClosedOrders = closedOrders.filter((order) => normalizedCurrentPhone && normalizePhone(order.buyerPhone) === normalizedCurrentPhone);
  const continuePaymentOrder = orders.find((order) => order.id === selectedOrderId && ["customer_payment", "pending_payment"].includes(order.status) && (!order.expiredAt || order.expiredAt > now)) || null;

  useEffect(() => {
    const savedOrderId = getSavedPaymentOrderId();
    if (!savedOrderId) return;

    const savedOrder = orders.find((order) => order.id === savedOrderId);
    if (!savedOrder) return;

    if (["customer_payment", "pending_payment"].includes(savedOrder.status) && (!savedOrder.expiredAt || savedOrder.expiredAt > now)) {
      if (selectedOrderId !== savedOrderId) setSelectedOrderId(savedOrderId);
      return;
    }

    clearSavedPaymentOrderId();
    if (selectedOrderId === savedOrderId) setSelectedOrderId("");
  }, [orders, now, selectedOrderId]);

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
        .product-main { text-align:center; display:grid; gap:8px; }
        .product-label { margin:0; font-size:12px; font-weight:500; color:var(--muted); letter-spacing:.2px; }
        .product-code { display:inline-flex; align-items:center; justify-content:center; min-width:86px; margin:2px auto; padding:8px 12px; border-radius:18px; background:#eefaff; border:1px solid var(--blue); color:#0f172a; font-size: 34px; font-weight: 950; letter-spacing:.8px; text-align:center; box-shadow:0 8px 18px rgba(15,23,42,.06); }
        .product-price-status { display:flex; align-items:center; justify-content:center; gap:8px; flex-wrap:wrap; }
        .pagination { display:flex; justify-content:center; align-items:center; gap:8px; flex-wrap:wrap; margin-top:14px; }
        .pagination .btn.active-page { background:#0f172a; color:#fff; }
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
        .qr-timer { margin:8px auto 2px; font-size:28px; font-weight:950; color:#0f172a; letter-spacing:1px; }
        .qr-note { margin:0 auto 8px; font-size:12px; color:#64748b; font-weight:700; }
        .shipping-note { margin:6px 0 0; font-size:13px; color:#0369a1; font-weight:900; }
        .back-arrow-btn { width:auto; min-width:0; height:34px; border-radius:999px; padding:6px 10px; display:inline-flex; align-items:center; justify-content:center; gap:5px; flex:0 0 auto !important; font-size:13px; font-weight:400; }
        .back-arrow-btn .back-icon { font-size:20px; line-height:1; font-weight:950; }
        .back-arrow-btn .back-text { font-weight:400; }
        .payment-confirm-row { margin-top: 14px; display:flex; justify-content:center; align-items:center; gap:10px; flex-wrap:wrap; }
        .payment-confirm-btn { background: var(--blue); color:#0f172a; min-width: 150px; }
        .payment-cancel-btn { background:#ffe4e6; color:#9f1239; min-width:96px; }
        .payment-info { display:grid; gap:8px; }
        .info-line { display:flex; justify-content:space-between; gap:8px; border-bottom:1px dashed #dbeafe; padding:7px 0; font-size:14px; }
        .toast { position:fixed; z-index:50; left:12px; right:12px; top:14px; transform:none; width:auto; max-width:none; background:white; color:#0f172a; border:1px solid var(--line); border-top:4px solid var(--blue); border-radius:12px; padding:12px 16px; box-shadow:0 12px 28px rgba(15,23,42,.14); font-weight:700; line-height:1.45; text-align:center; }
        .modal-backdrop { position:fixed; inset:0; background:rgba(15,23,42,.42); z-index:60; display:grid; place-items:center; padding:16px; }
        .modal { background:white; border-radius:24px; padding:16px; max-width:420px; width:100%; box-shadow:0 20px 60px rgba(15,23,42,.25); }
        .modal-title-primary { color:#0f172a; background:var(--blue); border-radius:16px; padding:10px 12px; text-align:center; margin-bottom:10px; }
        .modal-home-row { display:flex; justify-content:center; margin-top:14px; }
        .modal-home-btn { font-weight:400; padding:8px 14px; min-width:0; }
        .payment-back-row { margin:-4px 0 14px; display:flex; justify-content:flex-start; }
        .compact-setting { display:grid; grid-template-columns: auto 80px auto; gap:8px; align-items:center; margin-bottom:12px; }
        .packing-list { display:grid; gap:12px; }
        .packing-products { display:grid; gap:8px; }
        .packing-product-item { position:relative; padding-right:42px !important; }
        .packing-delete-x { position:absolute; top:7px; right:7px; width:28px; height:28px; border-radius:999px; border:0; background:#fee2e2; color:#991b1b; font-size:19px; font-weight:900; line-height:1; cursor:pointer; display:grid; place-items:center; }
        .continue-payment-box { border:1px solid #fde68a; background:#fffbeb; border-radius:18px; padding:12px; }
        @media (max-width: 850px) { .admin-grid { grid-template-columns: 1fr !important; } .form-grid { grid-template-columns: 1fr !important; } .customer-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } .between { align-items: flex-start; } }
        @media (max-width: 720px) { .app { padding:10px; } .header { border-radius:20px; } h1 { font-size:20px; } .grid-products { grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; } .product-code { font-size:28px; min-width:78px; padding:7px 10px; } .payment-layout { grid-template-columns: 1fr; } .qr-wrap { order:-1; } .tabs .btn:not(.back-arrow-btn) { flex:1; } .payment-tabs .back-arrow-btn { flex:0 0 auto !important; } }
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

      {packingDeleteTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Xác nhận xóa</h2>
            <p>
              {packingDeleteTarget.type === "all"
                ? `Bạn chắc chắn muốn xóa toàn bộ ${packingDeleteTarget.orders.length} sản phẩm trong màn hình đóng hàng?`
                : <>Bạn chắc chắn muốn xóa item <b>{packingDeleteTarget.orders[0]?.productCode}</b> khỏi màn hình đóng hàng?</>}
            </p>
            <p className="muted">Thao tác này sẽ xóa các item đã chốt khỏi danh sách đóng hàng.</p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn secondary" onClick={() => setPackingDeleteTarget(null)}>Không xóa</button>
              <button className="btn danger" onClick={confirmDeletePackingOrders}>Xóa</button>
            </div>
          </div>
        </div>
      )}

      {transferNoticeOrder && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2 className="modal-title-primary">Cảm ơn bạn đã ủng hộ</h2>
            <p className="muted">Mình đã nhận thông báo cho đơn <b>{transferNoticeOrder.productCode}</b>. Vui lòng chờ mình kiểm tra và xác nhận</p>
            <div className="modal-home-row">
              <button className="btn secondary modal-home-btn" onClick={() => { clearSavedPaymentOrderId(); setSelectedOrderId(""); setTransferNoticeOrder(null); goTo("/"); }}>Trang chủ</button>
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
          </div>
        </header>

        {mode === "payment" && (
          <div className="payment-back-row">
            <button className="btn secondary back-arrow-btn" onClick={() => goTo("/")} aria-label="Quay lại trang khách" title="Quay lại trang khách">
              <span className="back-icon">←</span>
              <span className="back-text">Quay lại</span>
            </button>
          </div>
        )}

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
            closedOrders={customerClosedOrders}
            hasBuyerPhone={Boolean(normalizedCurrentPhone)}
            showClosedOrders={showClosedOrders}
            setShowClosedOrders={setShowClosedOrders}
            handleBuy={handleBuy}
            continuePaymentOrder={continuePaymentOrder}
            onContinuePayment={() => goTo("/payment")}
          />
        )}

        {mode === "payment" && (
          <PaymentView
            activeOrders={customerActiveOrders}
            selectedOrder={selectedOrder}
            selectedOrderId={selectedOrderId}
            setSelectedOrderId={setSelectedOrderId}
            now={now}
            handleConfirmTransferred={handleConfirmTransferred}
            handleCancelOrder={handleCancelOrder}
            onGoHome={() => goTo("/")}
          />
        )}

        {mode === "admin" && (
          <AdminView
            adminUnlocked={adminUnlocked}
            pin={pin}
            setPin={setPin}
            loginAdmin={loginAdmin}
            products={products}
            activeOrders={adminActiveOrders}
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
            requestDeletePackingOrder={requestDeletePackingOrder}
            requestDeleteAllPackingOrders={requestDeleteAllPackingOrders}
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

function ShopView({ buyerIg, setBuyerIg, buyerFullName, setBuyerFullName, buyerPhone, setBuyerPhone, buyerOldAddress, setBuyerOldAddress, phoneError, addressError, showBuyerForm, setShowBuyerForm, search, setSearch, products, now, closedOrders, hasBuyerPhone, showClosedOrders, setShowClosedOrders, handleBuy, continuePaymentOrder, onContinuePayment }) {
  const [page, setPage] = useState(1);
  const perPage = 4;
  const keyword = search.trim().toLowerCase();

  const sortedProducts = useMemo(() => {
    return [...products]
      .filter((product) => !keyword || String(product.idCode || "").toLowerCase().includes(keyword))
      .sort((a, b) => String(a.idCode || "").localeCompare(String(b.idCode || ""), "vi", { numeric: true, sensitivity: "base" }));
  }, [products, keyword]);

  const totalPages = Math.max(1, Math.ceil(sortedProducts.length / perPage));
  const safePage = Math.min(page, totalPages);
  const pagedProducts = sortedProducts.slice((safePage - 1) * perPage, safePage * perPage);

  useEffect(() => {
    setPage(1);
  }, [keyword]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

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
              <p className="muted" style={{ marginTop: 5 }}>Nhập chính xác địa chỉ cũ, không viết tắt</p>
              {addressError && <p className="field-error">{addressError}</p>}
            </div>
          </div>
        )}
      </section>

      {continuePaymentOrder && (
        <section className="continue-payment-box">
          <div className="between" style={{ alignItems: "center" }}>
            <div>
              <b>Bạn có đơn đang chờ thanh toán</b>
              <p className="muted">ID: {continuePaymentOrder.productCode} · Tổng: {money(continuePaymentOrder.amount)}</p>
            </div>
            <button className="btn small" onClick={onContinuePayment}>Tiếp tục thanh toán</button>
          </div>
        </section>
      )}

      <section className="card" style={{ padding: 10 }}>
        <button className="between" style={{ width: "100%", border: 0, background: "transparent", padding: 0, textAlign: "left" }} onClick={() => setShowClosedOrders((value) => !value)}>
          <div style={{ minWidth: 0 }}>
            <b>Đơn đã chốt của bạn: {closedOrders.length}</b>
            <p className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {!hasBuyerPhone ? "Nhập đúng SĐT để xem đơn của bạn" : closedOrders.length ? closedOrders.slice(0, 5).map((order) => order.productCode).join(" · ") : "Chưa có đơn nào theo SĐT này"}
            </p>
          </div>
          <span className="status available">{showClosedOrders ? "Ẩn chi tiết" : "Xem chi tiết"}</span>
        </button>
        {showClosedOrders && (
          <div style={{ marginTop: 10 }}>
            {!hasBuyerPhone ? (
              <p className="muted">Nhập đúng SĐT để xem đơn của bạn.</p>
            ) : closedOrders.length ? (
              closedOrders.map((order) => (
                <div key={order.id} className="between" style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 16, padding: 10, marginBottom: 8 }}>
                  <div>
                    <b>ID: {order.productCode}</b>
                    <p className="muted">{money(order.amount)} · {statusLabel(order.packed ? "packed" : "unpacked")}</p>
                  </div>
                  <span className="status available">Đã chốt</span>
                </div>
              ))
            ) : (
              <p className="muted">Chưa có đơn đã chốt theo SĐT này.</p>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="search-box">
            <SearchIcon />
            <input className="input search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm ID sản phẩm, ví dụ A001..." />
          </div>
          {search && <button className="btn secondary small" onClick={() => setSearch("")}>Xóa</button>}
        </div>

        <div className="grid-products">
          {pagedProducts.map((product) => {
            const displayStatus = getDisplayProductStatus(product);
            const canBuy = displayStatus === "available";
            return (
              <article key={product.id} className="card product-card">
                <div className="product-main">
                  <p className="product-label">ID sản phẩm</p>
                  <div className="product-code">{product.idCode}</div>
                  <div className="product-price-status">
                    <b>{money(product.price)}</b>
                    <span className={statusClass(displayStatus)}>{statusLabel(displayStatus)}</span>
                  </div>
                </div>
                <button className="btn" disabled={!canBuy} style={{ width: "100%", marginTop: 12, opacity: canBuy ? 1 : .55, cursor: canBuy ? "pointer" : "not-allowed" }} onClick={() => handleBuy(product)}>
                  {canBuy ? "Mua" : statusLabel(displayStatus)}
                </button>
              </article>
            );
          })}
        </div>

        {sortedProducts.length === 0 && <p className="muted">Không tìm thấy sản phẩm phù hợp.</p>}

        {totalPages > 1 && (
          <div className="pagination">
            <button className="btn secondary small" disabled={safePage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="Trang trước">&lt;</button>
            {Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNumber) => (
              <button key={pageNumber} className={pageNumber === safePage ? "btn small active-page" : "btn secondary small"} onClick={() => setPage(pageNumber)}>{pageNumber}</button>
            ))}
            <button className="btn secondary small" disabled={safePage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} aria-label="Trang sau">&gt;</button>
          </div>
        )}
      </section>
    </div>
  );
}

function PaymentView({ activeOrders, selectedOrder, selectedOrderId, setSelectedOrderId, now, handleConfirmTransferred, handleCancelOrder, onGoHome }) {
  const [expiredNoticeOrder, setExpiredNoticeOrder] = useState(null);
  const [cancelNoticeOrder, setCancelNoticeOrder] = useState(null);

  useEffect(() => {
    if (!selectedOrder && activeOrders.length === 1) {
      setSelectedOrderId(activeOrders[0].id);
    }
  }, [activeOrders, selectedOrder, setSelectedOrderId]);

  const orderToShow = selectedOrder || activeOrders[0] || null;
  const secondsLeft = orderToShow ? Math.ceil(((orderToShow.expiredAt || now) - now) / 1000) : 0;
  const isPaymentExpired = Boolean(
    orderToShow &&
      ["customer_payment", "pending_payment", "expired"].includes(orderToShow.status) &&
      orderToShow.expiredAt &&
      secondsLeft <= 0
  );

  useEffect(() => {
    if (isPaymentExpired && orderToShow && expiredNoticeOrder?.id !== orderToShow.id) {
      setExpiredNoticeOrder(orderToShow);
      clearSavedPaymentOrderId();
    }
  }, [isPaymentExpired, orderToShow, expiredNoticeOrder]);

  function closeExpiredNotice() {
    clearSavedPaymentOrderId();
    if (expiredNoticeOrder?.id === selectedOrderId) {
      setSelectedOrderId("");
    }
    setExpiredNoticeOrder(null);
    onGoHome?.();
  }

  async function confirmCancelPayment() {
    if (!cancelNoticeOrder) return;
    await handleCancelOrder(cancelNoticeOrder);
    setCancelNoticeOrder(null);
    setSelectedOrderId("");
    clearSavedPaymentOrderId();
    onGoHome?.();
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {expiredNoticeOrder && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Đã hết thời gian chuyển tiền</h2>
            <p className="muted">Đơn <b>{expiredNoticeOrder.productCode}</b> đã quá thời gian thanh toán. Sản phẩm sẽ được mở lại để khách khác có thể mua.</p>
            <div className="modal-home-row">
              <button className="btn secondary modal-home-btn" onClick={closeExpiredNotice}>Đã hiểu</button>
            </div>
          </div>
        </div>
      )}

      {cancelNoticeOrder && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Xác nhận hủy đơn</h2>
            <p>Bạn chắc chắn muốn hủy đơn <b>{cancelNoticeOrder.productCode}</b>?</p>
            <p className="muted">Sau khi hủy, sản phẩm sẽ được mở lại để bạn hoặc khách khác có thể mua.</p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn secondary" onClick={() => setCancelNoticeOrder(null)}>Không hủy</button>
              <button className="btn payment-cancel-btn" onClick={confirmCancelPayment}>Hủy đơn</button>
            </div>
          </div>
        </div>
      )}

      {orderToShow ? (
        <section className="payment-layout">
          <div className="card" style={{ padding: 12 }}>
            <h2 style={{ marginBottom: 8 }}>Thông tin thanh toán</h2>
            <div className="payment-info">
              <div className="info-line"><span>ID sản phẩm</span><b>{orderToShow.productCode}</b></div>
              <div className="info-line"><span>SĐT</span><b>{orderToShow.buyerPhone || "-"}</b></div>
              <div className="info-line"><span>Giá sản phẩm</span><b>{money(orderToShow.productPrice)}</b></div>
              <div className="info-line"><span>Phí ship</span><b>{money(orderToShow.shippingFee)}</b></div>
              {Number(orderToShow.shippingFee || 0) > 0 && <p className="shipping-note">Đơn đầu tiên được cộng thêm 20.000đ phí ship.</p>}
              <div className="info-line" style={{ fontSize: 17 }}><span>Tổng cần chuyển</span><b>{money(orderToShow.amount)}</b></div>
              <div className="info-line"><span>Nội dung CK</span><b>{createTransferContent(orderToShow)}</b></div>
            </div>
            <div className="payment-confirm-row">
              <button
                className="btn payment-cancel-btn"
                disabled={isPaymentExpired}
                style={{ opacity: isPaymentExpired ? .55 : 1, cursor: isPaymentExpired ? "not-allowed" : "pointer" }}
                onClick={() => !isPaymentExpired && setCancelNoticeOrder(orderToShow)}
              >
                Hủy
              </button>
              <button
                className="btn payment-confirm-btn"
                disabled={isPaymentExpired}
                style={{ opacity: isPaymentExpired ? .55 : 1, cursor: isPaymentExpired ? "not-allowed" : "pointer" }}
                onClick={() => !isPaymentExpired && handleConfirmTransferred(orderToShow)}
              >
                Đã thanh toán
              </button>
            </div>
          </div>
          <div className="qr-wrap">
            <img src={createVietQrUrl(orderToShow)} alt="Mã QR chuyển khoản" />
            <div className="qr-timer">{countdown(secondsLeft)}</div>
            <p className="qr-note">Vui lòng chuyển khoản trong thời gian mã QR có hiệu lực</p>
            {Number(orderToShow.shippingFee || 0) > 0 && <p className="shipping-note">Đơn đầu tiên được cộng thêm 20.000đ phí ship.</p>}
          </div>
        </section>
      ) : (
        <section className="card"><p className="muted">Chưa có đơn đang chờ thanh toán.</p></section>
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

function AdminView({ adminUnlocked, pin, setPin, loginAdmin, products, activeOrders, closedOrders, showAdminClosedOrders, setShowAdminClosedOrders, productForm, setProductForm, handleAddProduct, handleDeleteProduct, handleEditProduct, cancelEditProduct, handleSetProductStatus, handleConfirmPaid, handleCancelOrder, settings, handleUpdatePaymentMinutes, adminProductSearch, setAdminProductSearch, adminScreen, setAdminScreen, handleTogglePackedByPhone, requestDeletePackingOrder, requestDeleteAllPackingOrders }) {
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
    return <PackingView packingOrders={packingOrders} onBack={() => setAdminScreen("main")} onTogglePacked={handleTogglePackedByPhone} onRequestDeleteOrder={requestDeletePackingOrder} onRequestDeleteAll={requestDeleteAllPackingOrders} />;
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
          {activeOrders.length === 0 ? <p className="muted">Chưa có đơn khách đã thanh toán đang chờ xác nhận.</p> : activeOrders.map((order) => (
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
                  <p className="product-label">ID sản phẩm</p>
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

function PackingView({ packingOrders, onBack, onTogglePacked, onRequestDeleteOrder, onRequestDeleteAll }) {
  const totalProducts = packingOrders.reduce((sum, group) => sum + group.orders.length, 0);
  const allPackingOrderItems = packingOrders.flatMap((group) => group.orders);
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
        {allPackingOrderItems.length > 0 && (
          <button className="btn danger small" onClick={() => onRequestDeleteAll(allPackingOrderItems)}>Xóa toàn bộ sản phẩm</button>
        )}
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
                  <div key={order.id} className="between packing-product-item" style={{ border: "1px solid #e2e8f0", borderRadius: 14, padding: 10 }}>
                    <button className="packing-delete-x" onClick={() => onRequestDeleteOrder(order)} aria-label={`Xóa item ${order.productCode}`} title="Xóa item">×</button>
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