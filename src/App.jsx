import React, { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, runTransaction, setDoc, updateDoc, writeBatch } from "firebase/firestore";
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
const ACTIVE_PAYMENT_LOCK_COLLECTION = "activePaymentLocks";
const PAYMENT_EXPIRED_GRACE_MS = 60000;

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
  const [buyingProductId, setBuyingProductId] = useState("");
  const [customerCancelTarget, setCustomerCancelTarget] = useState(null);

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
    if (buyingProductId) return;

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
        (!order.expiredAt || order.expiredAt + PAYMENT_EXPIRED_GRACE_MS > now)
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
    const orderId = String(Date.now()).slice(-6) + "-" + product.idCode;
    const expiresInMs = Math.max(1, Number(settings.paymentMinutes || DEFAULT_PAYMENT_MINUTES)) * 60 * 1000;

    setBuyingProductId(product.id);

    try {
      const createdOrder = await runTransaction(db, async (transaction) => {
        const productRef = doc(db, "products", product.id);
        const orderRef = doc(db, "orders", orderId);
        const lockRef = doc(db, ACTIVE_PAYMENT_LOCK_COLLECTION, normalizedBuyerPhone);

        const productSnap = await transaction.get(productRef);
        if (!productSnap.exists()) {
          const error = new Error("PRODUCT_NOT_FOUND");
          error.code = "PRODUCT_NOT_FOUND";
          throw error;
        }

        const liveProduct = productSnap.data();
        if (liveProduct.status !== "available") {
          const error = new Error("PRODUCT_NOT_AVAILABLE");
          error.code = "PRODUCT_NOT_AVAILABLE";
          throw error;
        }

        const lockSnap = await transaction.get(lockRef);
        if (lockSnap.exists()) {
          const lock = lockSnap.data();
          if (["customer_payment", "pending_payment"].includes(lock.status) && (!lock.expiredAt || lock.expiredAt + PAYMENT_EXPIRED_GRACE_MS > Date.now())) {
            const error = new Error("ACTIVE_PAYMENT_ORDER");
            error.code = "ACTIVE_PAYMENT_ORDER";
            error.orderId = lock.orderId || "";
            throw error;
          }
        }

        const productPrice = Number(liveProduct.price || product.price || 0);
        const newOrder = {
          id: orderId,
          productId: product.id,
          productCode: liveProduct.idCode || product.idCode,
          productPrice,
          shippingFee,
          amount: productPrice + shippingFee,
          status: "customer_payment",
          buyerIg: buyerIg.trim(),
          buyerFullName: buyerFullName.trim(),
          buyerPhone: normalizedBuyerPhone,
          buyerOldAddress: buyerOldAddress.trim(),
          createdAt: Date.now(),
          expiredAt: Date.now() + expiresInMs,
          packed: false,
        };

        transaction.set(orderRef, newOrder);
        transaction.update(productRef, {
          status: "reserved",
          reservedUntil: newOrder.expiredAt,
          updatedAt: Date.now(),
        });
        transaction.set(lockRef, {
          orderId,
          productId: product.id,
          buyerPhone: normalizedBuyerPhone,
          status: "customer_payment",
          expiredAt: newOrder.expiredAt,
          updatedAt: Date.now(),
        });

        return newOrder;
      });

      setSelectedOrderId(createdOrder.id);
      savePaymentOrderId(createdOrder.id);
      goTo("/payment");
      showMessage(
        isFirstOrderForBuyer
          ? "Đơn đầu tiên đã cộng 20.000đ phí ship."
          : "Đã giữ sản phẩm, vui lòng chuyển khoản trong thời gian hiển thị."
      );
    } catch (error) {
      console.error("Lỗi tạo đơn:", error);
      if (error.code === "ACTIVE_PAYMENT_ORDER") {
        if (error.orderId) {
          setSelectedOrderId(error.orderId);
          savePaymentOrderId(error.orderId);
        }
        showMessage("Bạn đang có đơn cần thanh toán, hãy thanh toán hoặc hủy đơn đó để mua đơn này");
      } else if (error.code === "PRODUCT_NOT_AVAILABLE") {
        showMessage("Sản phẩm này vừa có người giữ trước. Bạn chọn sản phẩm khác nhé.");
      } else {
        showMessage("Không tạo được đơn. Hãy kiểm tra Firebase/Vercel.");
      }
    } finally {
      setBuyingProductId("");
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

      if (order.buyerPhone) {
        batch.delete(doc(db, ACTIVE_PAYMENT_LOCK_COLLECTION, normalizePhone(order.buyerPhone)));
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
      if (order.buyerPhone) {
        batch.delete(doc(db, ACTIVE_PAYMENT_LOCK_COLLECTION, normalizePhone(order.buyerPhone)));
      }
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
      (order) => ["customer_payment", "pending_payment"].includes(order.status) && order.expiredAt && order.expiredAt + PAYMENT_EXPIRED_GRACE_MS <= now
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

        if (order.buyerPhone) {
          batch.delete(doc(db, ACTIVE_PAYMENT_LOCK_COLLECTION, normalizePhone(order.buyerPhone)));
        }

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
  const customerPaymentStatuses = ["customer_payment", "pending_payment"];
  const customerPaymentOrders = orders.filter((order) => customerPaymentStatuses.includes(order.status));
  const customerActiveOrders = customerPaymentOrders.filter((order) => normalizedCurrentPhone && normalizePhone(order.buyerPhone) === normalizedCurrentPhone);
  const adminActiveOrders = orders.filter((order) => order.status === "waiting_confirm");
  const closedOrders = orders.filter((order) => order.status === "paid");
  const customerClosedOrders = closedOrders.filter((order) => normalizedCurrentPhone && normalizePhone(order.buyerPhone) === normalizedCurrentPhone);
  const continuePaymentOrder = orders.find((order) => order.id === selectedOrderId && customerPaymentStatuses.includes(order.status) && (!order.expiredAt || order.expiredAt + PAYMENT_EXPIRED_GRACE_MS > now)) || customerActiveOrders.find((order) => !order.expiredAt || order.expiredAt + PAYMENT_EXPIRED_GRACE_MS > now) || null;

  useEffect(() => {
    const savedOrderId = getSavedPaymentOrderId();
    if (!savedOrderId) return;

    const savedOrder = orders.find((order) => order.id === savedOrderId);
    if (!savedOrder) return;

    if (["customer_payment", "pending_payment"].includes(savedOrder.status) && (!savedOrder.expiredAt || savedOrder.expiredAt + PAYMENT_EXPIRED_GRACE_MS > now)) {
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
        .app { min-height: 100vh; padding: 14px; background: radial-gradient(circle at top left, rgba(179,235,242,.7), transparent 34%), linear-gradient(180deg,#f9fdff 0%,#eefbff 100%); }
        .shell { max-width: 1180px; margin: 0 auto; }
        .header { position:relative; overflow:hidden; background: linear-gradient(135deg,#0f172a 0%,#164e63 55%,#B3EBF2 100%); color:white; border: 0; border-radius: 28px; padding: 18px; box-shadow: 0 18px 44px rgba(15,23,42,.18); margin-bottom: 16px; }
        .header::after { content:""; position:absolute; width:180px; height:180px; right:-54px; top:-70px; background:rgba(255,255,255,.22); border-radius:999px; }
        .header .muted { color:rgba(255,255,255,.78); }
        .title { display:flex; align-items:center; gap:10px; }
        .logo { width:54px; height:54px; border-radius:20px; background: rgba(255,255,255,.96); color:#0f172a; display:grid; place-items:center; font-weight:950; box-shadow:0 12px 30px rgba(15,23,42,.2); }
        h1 { font-size: 24px; margin:0; }
        h2 { font-size: 18px; margin:0 0 10px; }
        .muted { color: var(--muted); font-size: 13px; margin: 4px 0; }
        .row { display:flex; align-items:center; gap:8px; }
        .between { display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .tabs { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
        .btn { border:0; background: linear-gradient(135deg,#B3EBF2,#8de1ee); color:#0f172a; border-radius: 16px; padding: 11px 15px; font-weight: 850; cursor:pointer; transition: .18s; box-shadow:0 10px 22px rgba(45,173,190,.16); }
        .btn:hover { transform: translateY(-1px); filter: brightness(.99); }
        .btn.secondary { background:rgba(255,255,255,.75); border:1px solid rgba(179,235,242,.9); box-shadow:none; }
        .btn.danger { background:#fee2e2; color:#991b1b; }
        .btn.success { background:#dcfce7; color:#166534; }
        .btn.small { padding: 7px 10px; border-radius: 12px; font-size: 13px; }
        .card { background:rgba(255,255,255,.88); backdrop-filter: blur(12px); border:1px solid rgba(179,235,242,.75); border-radius: 26px; padding: 16px; box-shadow: 0 18px 42px rgba(15, 23, 42, .08); }
        .form-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; }
        .input { width:100%; border:1.5px solid rgba(73,190,209,.45); border-radius: 18px; padding: 13px 14px; outline:none; background:rgba(255,255,255,.95); box-shadow: inset 0 1px 0 rgba(255,255,255,.8); }
        .input:focus { box-shadow: 0 0 0 4px rgba(179,235,242,.35); }
        .field-error { color:#dc2626; font-size:12px; margin:4px 0 0; }
        .grid-products { display:grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap:14px; }
        .product-card { position:relative; min-height: 188px; display:flex; flex-direction:column; justify-content:space-between; overflow:hidden; isolation:isolate; }
        .product-card::before { content:""; position:absolute; inset:0 0 auto 0; height:7px; background:linear-gradient(90deg,#B3EBF2,#0ea5e9,#B3EBF2); z-index:-1; }
        .product-main { text-align:center; display:grid; gap:8px; }
        .product-label { margin:0; font-size:12px; font-weight:500; color:var(--muted); letter-spacing:.2px; }
        .product-code { display:inline-flex; align-items:center; justify-content:center; min-width:92px; margin:4px auto; padding:10px 14px; border-radius:24px; background:linear-gradient(180deg,#f1feff,#d8f7fb); border:1px solid rgba(73,190,209,.45); color:#0f172a; font-size: 36px; font-weight: 950; letter-spacing:.8px; text-align:center; box-shadow:0 16px 30px rgba(14,116,144,.12); }
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
        .qr-wrap { text-align:center; background:rgba(255,255,255,.92); border:1px solid rgba(179,235,242,.8); border-radius:28px; padding:14px; box-shadow:0 18px 44px rgba(15,23,42,.08); }
        .qr-wrap img { max-width:100%; width:320px; aspect-ratio:1/1; object-fit:contain; }
        .qr-timer { margin:8px auto 2px; font-size:28px; font-weight:950; color:#0f172a; letter-spacing:1px; }
        .qr-note { margin:0 auto 8px; font-size:12px; color:#64748b; font-weight:700; }
        .shipping-note { margin:6px 0 0; font-size:13px; color:#0369a1; font-weight:900; }
        .back-arrow-btn { width:auto; min-width:0; height:34px; border-radius:999px; padding:6px 10px; display:inline-flex; align-items:center; justify-content:center; gap:5px; flex:0 0 auto !important; font-size:13px; font-weight:400; }
        .back-arrow-btn .back-icon { font-size:20px; line-height:1; font-weight:950; }
        .back-arrow-btn .back-text { font-weight:400; }
        .payment-confirm-row { margin-top:14px; display:flex; justify-content:center; align-items:center; gap:10px; flex-wrap:wrap; }
        .payment-confirm-btn { background:var(--blue); color:#0f172a; min-width:150px; }
        .payment-cancel-btn { background:#ffe4e6; color:#9f1239; min-width:96px; }
        .payment-info { display:grid; gap:8px; }
        .info-line { display:flex; justify-content:space-between; gap:8px; border-bottom:1px dashed #dbeafe; padding:7px 0; font-size:14px; }
        .toast { position:fixed; z-index:50; left:12px; right:12px; top:14px; transform:none; width:auto; max-width:none; background:white; color:#0f172a; border:1px solid var(--line); border-top:4px solid var(--blue); border-radius:12px; padding:12px 16px; box-shadow:0 12px 28px rgba(15,23,42,.14); font-weight:700; line-height:1.45; text-align:center; }
        .modal-backdrop { position:fixed; inset:0; background:rgba(15,23,42,.42); z-index:60; display:grid; place-items:center; padding:16px; }
        .modal { background:white; border-radius:18px; padding:16px; max-width:420px; width:100%; box-shadow:0 20px 60px rgba(15,23,42,.25); }
        .modal-title-primary { color:#0f172a; background:var(--blue); border-radius:12px; padding:10px 12px; text-align:center; margin-bottom:10px; }
        .modal-home-row { display:flex; justify-content:center; margin-top:14px; }
        .modal-home-btn { font-weight:400; padding:8px 14px; min-width:0; }
        .payment-back-row { margin:-4px 0 14px; display:flex; justify-content:flex-start; }
        .compact-setting { display:grid; grid-template-columns: auto 80px auto; gap:8px; align-items:center; margin-bottom:12px; }
        .packing-list { display:grid; gap:12px; }
        .packing-products { display:grid; gap:8px; }
        .packing-product-item { position:relative; padding-right:42px !important; }
        .packing-delete-x { position:absolute; top:7px; right:7px; width:28px; height:28px; border-radius:999px; border:0; background:#fee2e2; color:#991b1b; font-size:19px; font-weight:900; line-height:1; cursor:pointer; display:grid; place-items:center; }
        .continue-payment-box { border:1px solid #fde68a; background:#fffbeb; border-radius:18px; padding:12px; }

        .admin-page { display:grid; gap:14px; }
        .admin-hero { background:linear-gradient(135deg, #0f172a 0%, #17435a 58%, #b3ebf2 100%); color:white; border-radius:26px; padding:18px; box-shadow:0 18px 45px rgba(15,23,42,.18); overflow:hidden; position:relative; }
        .admin-hero:after { content:""; position:absolute; width:160px; height:160px; right:-40px; top:-45px; border-radius:999px; background:rgba(255,255,255,.18); }
        .admin-hero h2 { font-size:24px; margin:3px 0 4px; }
        .admin-hero p { margin:0; color:rgba(255,255,255,.82); font-size:13px; }
        .admin-kicker { margin:0 !important; color:#b3ebf2 !important; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
        .admin-tabs-card { background:white; border:1px solid var(--line); border-radius:22px; padding:8px; display:grid; grid-template-columns:1fr 1fr; gap:8px; box-shadow:0 10px 24px rgba(15,23,42,.05); }
        .admin-tab { border:0; border-radius:16px; padding:11px 12px; background:#f1fbfd; color:#334155; font-weight:800; display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer; transition:.15s; }
        .admin-tab b { min-width:24px; height:24px; border-radius:999px; background:white; display:inline-grid; place-items:center; font-size:12px; color:#0f172a; }
        .admin-tab.active { background:var(--blue); color:#0f172a; box-shadow:0 10px 22px rgba(46,181,207,.20); }
        .admin-stats { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; }
        .admin-stat-card { background:white; border:1px solid var(--line); border-radius:20px; padding:13px; box-shadow:0 10px 24px rgba(15,23,42,.05); }
        .admin-stat-card span { color:var(--muted); font-size:12px; font-weight:800; }
        .admin-stat-card b { display:block; font-size:26px; line-height:1.1; margin:4px 0; }
        .admin-stat-card p { margin:0; font-size:12px; color:#64748b; }
        .admin-stat-card.warning { border-color:#fde68a; background:#fffbeb; }
        .admin-stat-card.success { border-color:#bbf7d0; background:#f0fdf4; }
        .admin-stat-card.muted-card { background:#f8fafc; }
        .admin-grid-modern { display:grid; grid-template-columns:minmax(280px, 360px) 1fr; gap:14px; align-items:start; }
        .admin-main-column { display:grid; gap:14px; }
        .admin-panel { border-radius:24px; }
        .admin-form-panel { position:sticky; top:12px; }
        .admin-section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:12px; }
        .admin-section-heading h2 { margin:0 0 3px; }
        .admin-count-badge { min-width:34px; height:34px; padding:0 10px; border-radius:999px; background:#eefaff; border:1px solid var(--blue); display:inline-flex; align-items:center; justify-content:center; font-weight:900; }
        .admin-setting-card { background:#f8fdff; border:1px dashed var(--blue); border-radius:16px; padding:10px; margin-bottom:12px; }
        .admin-setting-card > span { display:block; color:var(--muted); font-size:12px; font-weight:800; margin-bottom:6px; }
        .admin-setting-card .input { max-width:90px; padding:9px 10px; }
        .admin-product-form { display:grid; gap:10px; }
        .admin-product-form label span { display:block; font-size:12px; color:var(--muted); font-weight:800; margin:0 0 5px; }
        .admin-price-preview { margin:0; border-radius:14px; background:#f0fdf4; border:1px solid #bbf7d0; padding:9px 10px; font-size:13px; }
        .admin-primary-btn { background:linear-gradient(135deg, var(--blue), #9de2ec); }
        .admin-empty-state { background:#f8fafc; border:1px dashed #cbd5e1; border-radius:18px; padding:18px; color:#64748b; text-align:center; font-weight:800; }
        .admin-order-list { display:grid; gap:10px; }
        .admin-order-card { border:1px solid #d9eef2; background:linear-gradient(180deg, #ffffff 0%, #f8fdff 100%); border-radius:20px; padding:12px; box-shadow:0 10px 20px rgba(15,23,42,.04); }
        .admin-order-top { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; margin-bottom:10px; }
        .admin-order-label { color:var(--muted); font-size:11px; font-weight:900; }
        .admin-order-top h3 { margin:2px 0 0; font-size:24px; }
        .admin-order-info { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px; }
        .admin-order-info p { margin:0; background:white; border:1px solid #e2eef2; border-radius:14px; padding:8px; }
        .admin-order-info span { display:block; color:var(--muted); font-size:11px; font-weight:800; margin-bottom:2px; }
        .admin-order-info b { font-size:13px; word-break:break-word; }
        .admin-address-box { margin-top:8px; padding:9px 10px; border-radius:14px; background:#fffbeb; border:1px solid #fde68a; font-size:13px; }
        .admin-card-actions { display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap; margin-top:10px; }
        .admin-collapsible-head { width:100%; border:0; background:transparent; text-align:left; padding:0; display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:pointer; }
        .admin-collapsible-head h2 { margin:0 0 3px; }
        .admin-collapsible-head p { margin:0; color:var(--muted); font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:520px; }
        .admin-closed-list { display:grid; gap:8px; margin-top:12px; }
        .admin-closed-item { display:flex; justify-content:space-between; gap:10px; border:1px solid #bbf7d0; background:#f0fdf4; border-radius:16px; padding:10px; }
        .admin-closed-item p { margin:4px 0 0; color:#64748b; font-size:13px; }
        .admin-products-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(155px, 1fr)); gap:10px; }
        .admin-product-card { background:white; border:1px solid var(--line); border-radius:20px; padding:12px; box-shadow:0 10px 20px rgba(15,23,42,.04); display:grid; gap:7px; }
        .admin-product-card p { margin:0; color:var(--muted); font-size:12px; font-weight:800; }
        .admin-product-card h3 { margin:0; font-size:28px; line-height:1; }
        .admin-product-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
        .admin-login-card { max-width:460px; margin:0 auto; text-align:center; }
        .admin-login-icon { width:58px; height:58px; margin:0 auto 10px; border-radius:20px; background:var(--blue); display:grid; place-items:center; font-weight:950; font-size:20px; }
        /* Component UI polish */
        .component-card { position:relative; overflow:hidden; border-radius:18px; background:linear-gradient(180deg,#ffffff 0%,#fbfeff 100%); }
        .component-card::before { content:""; position:absolute; inset:0 0 auto 0; height:4px; background:linear-gradient(90deg,var(--blue),#e0fbff,transparent); pointer-events:none; }
        .section-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:12px; }
        .section-title { margin:0; font-size:18px; font-weight:850; letter-spacing:-.2px; }
        .section-subtitle { margin:4px 0 0; color:var(--muted); font-size:13px; line-height:1.4; }
        .filter-bar { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 14px; padding:7px; background:rgba(255,255,255,.72); border:1px solid rgba(179,235,242,.85); border-radius:20px; box-shadow: inset 0 1px 0 rgba(255,255,255,.9); }
        .filter-pill { border:0; border-radius:15px; padding:10px 13px; background:transparent; color:#475569; font-size:13px; font-weight:850; cursor:pointer; transition:.18s; }
        .filter-pill.active { background:linear-gradient(135deg,#0f172a,#164e63); color:white; box-shadow:0 10px 24px rgba(15,23,42,.16); }
        .product-card { border-radius:26px; border-color:rgba(179,235,242,.9); background:linear-gradient(180deg,#ffffff 0%,#f2fbff 100%); }
        .product-card:hover { transform:translateY(-4px); box-shadow:0 24px 50px rgba(15,23,42,.13); }
        .product-buy-btn { width:100%; margin-top:14px; border-radius:18px; min-height:48px; font-size:16px; }
        .empty-state { text-align:center; color:var(--muted); padding:18px 10px; border:1px dashed var(--line); border-radius:16px; background:#fbfeff; }
        .info-line { display:flex; justify-content:space-between; align-items:center; gap:12px; border-bottom:1px dashed #dbeafe; padding:9px 0; font-size:14px; }
        .info-line span { color:#64748b; }
        .info-value { font-weight:850; text-align:right; }
        .info-line.highlight { margin-top:4px; padding:12px 10px; border:1px solid var(--line); border-radius:14px; background:#f1fbfd; }
        .info-line.highlight span { color:#0f172a; font-weight:800; }
        .info-line.highlight .info-value { font-size:18px; }
        .payment-manual { margin-top:12px; padding:12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; }
        .payment-manual-title { margin:0 0 8px; font-size:13px; color:#334155; font-weight:900; }
        .payment-manual-grid { display:grid; gap:6px; font-size:13px; color:#475569; }
        .qr-wrap { border-radius:18px; background:linear-gradient(180deg,#ffffff 0%,#f7fdff 100%); }
        @media (max-width: 850px) { .admin-grid { grid-template-columns: 1fr !important; } .admin-grid-modern { grid-template-columns:1fr; } .admin-form-panel { position:static; } .admin-stats { grid-template-columns:repeat(2, minmax(0,1fr)); } .form-grid { grid-template-columns: 1fr !important; } .customer-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } .between { align-items: flex-start; } }
        @media (max-width: 720px) { .app { padding:10px; } .header { border-radius:20px; } h1 { font-size:20px; } .grid-products { grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; } .product-code { font-size:28px; min-width:78px; padding:7px 10px; } .payment-layout { grid-template-columns: 1fr; } .qr-wrap { order:-1; } .tabs .btn { flex:1; } .admin-hero { border-radius:22px; padding:15px; } .admin-stats { grid-template-columns:1fr 1fr; } .admin-order-info { grid-template-columns:1fr; } .admin-card-actions .btn { flex:1; } .admin-products-grid { grid-template-columns:repeat(2, minmax(0,1fr)); } }
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

      {customerCancelTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Xác nhận hủy đơn</h2>
            <p>Bạn chắc chắn muốn hủy đơn <b>{customerCancelTarget.productCode}</b>?</p>
            <p className="muted">Sau khi hủy, sản phẩm sẽ được mở lại để bạn hoặc khách khác có thể mua.</p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn secondary" onClick={() => setCustomerCancelTarget(null)}>Không hủy</button>
              <button className="btn payment-cancel-btn" onClick={async () => { const order = customerCancelTarget; setCustomerCancelTarget(null); await handleCancelOrder(order); }}>Hủy đơn</button>
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
          <div className="tabs"></div>
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
            buyingProductId={buyingProductId}
            continuePaymentOrder={continuePaymentOrder}
            onContinuePayment={() => goTo("/payment")}
            onCancelContinuePayment={(order) => setCustomerCancelTarget(order)}
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

function FilterPills({ value, onChange, options }) {
  return (
    <div className="filter-bar">
      {options.map((option) => (
        <button key={option.value} className={value === option.value ? "filter-pill active" : "filter-pill"} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ProductCardItem({ product, displayStatus, canBuy, isBuyingThis, isBuyingOther, isBuying, onBuy }) {
  return (
    <article className="card product-card">
      <div className="product-main">
        <p className="product-label">ID sản phẩm</p>
        <div className="product-code">{product.idCode}</div>
        <div className="product-price-status">
          <b>{money(product.price)}</b>
          <span className={statusClass(displayStatus)}>{statusLabel(displayStatus)}</span>
        </div>
      </div>
      <button
        className="btn product-buy-btn"
        disabled={!canBuy || Boolean(isBuying)}
        style={{ opacity: canBuy && !isBuyingOther ? 1 : .55, cursor: canBuy && !isBuying ? "pointer" : "not-allowed" }}
        onClick={onBuy}
      >
        {isBuyingThis ? "Đang giữ..." : canBuy ? "Mua" : statusLabel(displayStatus)}
      </button>
    </article>
  );
}

function InfoLine({ label, value, highlight = false }) {
  return (
    <div className={highlight ? "info-line highlight" : "info-line"}>
      <span>{label}</span>
      <b className="info-value">{value}</b>
    </div>
  );
}

function ShopView({ buyerIg, setBuyerIg, buyerFullName, setBuyerFullName, buyerPhone, setBuyerPhone, buyerOldAddress, setBuyerOldAddress, phoneError, addressError, showBuyerForm, setShowBuyerForm, search, setSearch, products, now, closedOrders, hasBuyerPhone, showClosedOrders, setShowClosedOrders, handleBuy, buyingProductId, continuePaymentOrder, onContinuePayment, onCancelContinuePayment }) {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const perPage = 4;
  const keyword = search.trim().toLowerCase();

  const sortedProducts = useMemo(() => {
    return [...products]
      .filter((product) => !keyword || String(product.idCode || "").toLowerCase().includes(keyword))
      .filter((product) => {
        const displayStatus = getDisplayProductStatus(product);
        if (statusFilter === "all") return true;
        if (statusFilter === "available") return displayStatus === "available";
        if (statusFilter === "reserved") return ["reserved", "customer_payment", "pending_payment", "waiting_confirm"].includes(displayStatus);
        if (statusFilter === "sold") return displayStatus === "sold";
        return true;
      })
      .sort((a, b) => String(a.idCode || "").localeCompare(String(b.idCode || ""), "vi", { numeric: true, sensitivity: "base" }));
  }, [products, keyword, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(sortedProducts.length / perPage));
  const safePage = Math.min(page, totalPages);
  const pagedProducts = sortedProducts.slice((safePage - 1) * perPage, safePage * perPage);

  useEffect(() => { setPage(1); }, [keyword, statusFilter]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="card">
        <button className="between" style={{ width: "100%", border: 0, background: "transparent", padding: 0, textAlign: "left" }} onClick={() => setShowBuyerForm((value) => !value)}>
          <div><h2 style={{ marginBottom: 3 }}>Thông tin khách</h2><p className="muted">Tên IG, họ tên, SĐT và địa chỉ cũ sẽ dùng cho đơn hàng.</p></div>
          <span className="status available">{showBuyerForm ? "Ẩn" : "Nhập"}</span>
        </button>
        {showBuyerForm && (
          <div className="form-grid customer-form-grid" style={{ marginTop: 12 }}>
            <div><input className="input" value={buyerIg} onChange={(event) => setBuyerIg(event.target.value)} placeholder="Tên IG" /></div>
            <div><input className="input" value={buyerFullName} onChange={(event) => setBuyerFullName(event.target.value)} placeholder="Họ tên" /></div>
            <div><input className="input" value={buyerPhone} onChange={(event) => setBuyerPhone(event.target.value)} placeholder="SĐT" inputMode="tel" />{phoneError && <p className="field-error">{phoneError}</p>}</div>
            <div><input className="input" value={buyerOldAddress} onChange={(event) => setBuyerOldAddress(event.target.value)} placeholder="Địa chỉ (Cũ)" /><p className="muted" style={{ marginTop: 5 }}>Nhập chính xác địa chỉ cũ, không viết tắt</p>{addressError && <p className="field-error">{addressError}</p>}</div>
          </div>
        )}
      </section>

      {continuePaymentOrder && (
        <section className="continue-payment-box">
          <div className="between" style={{ alignItems: "center" }}>
            <div><b>Bạn có đơn đang chờ thanh toán</b><p className="muted">ID: {continuePaymentOrder.productCode} · Tổng: {money(continuePaymentOrder.amount)}</p></div>
            <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button className="btn small" onClick={onContinuePayment}>Tiếp tục thanh toán</button>
              <button className="btn payment-cancel-btn small" onClick={() => onCancelContinuePayment?.(continuePaymentOrder)}>Hủy đơn</button>
            </div>
          </div>
        </section>
      )}

      <section className="card" style={{ padding: 10 }}>
        <button className="between" style={{ width: "100%", border: 0, background: "transparent", padding: 0, textAlign: "left" }} onClick={() => setShowClosedOrders((value) => !value)}>
          <div style={{ minWidth: 0 }}><b>Đơn đã chốt của bạn: {closedOrders.length}</b><p className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{!hasBuyerPhone ? "Nhập đúng SĐT để xem đơn của bạn" : closedOrders.length ? closedOrders.slice(0, 5).map((order) => order.productCode).join(" · ") : "Chưa có đơn nào theo SĐT này"}</p></div>
          <span className="status available">{showClosedOrders ? "Ẩn chi tiết" : "Xem chi tiết"}</span>
        </button>
        {showClosedOrders && <div style={{ marginTop: 10 }}>{!hasBuyerPhone ? <p className="muted">Nhập đúng SĐT để xem đơn của bạn.</p> : closedOrders.length ? closedOrders.map((order) => <div key={order.id} className="between" style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", borderRadius: 16, padding: 10, marginBottom: 8 }}><div><b>ID: {order.productCode}</b><p className="muted">{money(order.amount)} · {statusLabel(order.packed ? "packed" : "unpacked")}</p></div><span className="status available">Đã chốt</span></div>) : <p className="muted">Chưa có đơn đã chốt theo SĐT này.</p>}</div>}
      </section>

      <section className="card">
        <div className="row" style={{ marginBottom: 10 }}><div className="search-box"><SearchIcon /><input className="input search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm ID sản phẩm, ví dụ A001..." /></div>{search && <button className="btn secondary small" onClick={() => setSearch("")}>Xóa</button>}</div>
        <FilterPills
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: "all", label: "Tất cả" },
            { value: "available", label: "Còn hàng" },
            { value: "reserved", label: "Đang giữ" },
            { value: "sold", label: "Đã bán" },
          ]}
        />
        <div className="grid-products">
          {pagedProducts.map((product) => {
            const displayStatus = getDisplayProductStatus(product);
            const canBuy = displayStatus === "available";
            const isBuyingThis = buyingProductId === product.id;
            const isBuyingOther = Boolean(buyingProductId) && !isBuyingThis;
            return (
              <ProductCardItem
                key={product.id}
                product={product}
                displayStatus={displayStatus}
                canBuy={canBuy}
                isBuyingThis={isBuyingThis}
                isBuyingOther={isBuyingOther}
                isBuying={Boolean(buyingProductId)}
                onBuy={() => handleBuy(product)}
              />
            );
          })}
        </div>
        {sortedProducts.length === 0 && <p className="muted">Không tìm thấy sản phẩm phù hợp.</p>}
        {totalPages > 1 && <div className="pagination"><button className="btn secondary small" disabled={safePage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="Trang trước">&lt;</button>{Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNumber) => <button key={pageNumber} className={pageNumber === safePage ? "btn small active-page" : "btn secondary small"} onClick={() => setPage(pageNumber)}>{pageNumber}</button>)}<button className="btn secondary small" disabled={safePage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} aria-label="Trang sau">&gt;</button></div>}
      </section>
    </div>
  );
}

function PaymentView({ activeOrders, selectedOrder, selectedOrderId, setSelectedOrderId, now, handleConfirmTransferred, handleCancelOrder, onGoHome }) {
  const [expiredNoticeOrder, setExpiredNoticeOrder] = useState(null);
  const [cancelNoticeOrder, setCancelNoticeOrder] = useState(null);

  useEffect(() => { if (!selectedOrder && activeOrders.length === 1) setSelectedOrderId(activeOrders[0].id); }, [activeOrders, selectedOrder, setSelectedOrderId]);

  const orderToShow = selectedOrder || activeOrders[0] || null;
  const secondsLeft = orderToShow ? Math.ceil(((orderToShow.expiredAt || now) - now) / 1000) : 0;
  const isPaymentExpired = Boolean(orderToShow && ["customer_payment", "pending_payment", "expired"].includes(orderToShow.status) && orderToShow.expiredAt && secondsLeft <= 0);
  const isBeyondGrace = Boolean(orderToShow?.expiredAt && now > orderToShow.expiredAt + PAYMENT_EXPIRED_GRACE_MS);

  useEffect(() => { if (isPaymentExpired && orderToShow && expiredNoticeOrder?.id !== orderToShow.id) { setExpiredNoticeOrder(orderToShow); clearSavedPaymentOrderId(); } }, [isPaymentExpired, orderToShow, expiredNoticeOrder]);

  function closeExpiredNotice() { clearSavedPaymentOrderId(); if (expiredNoticeOrder?.id === selectedOrderId) setSelectedOrderId(""); setExpiredNoticeOrder(null); onGoHome?.(); }
  async function confirmTransferredAfterExpired() { if (!expiredNoticeOrder || isBeyondGrace) return; await handleConfirmTransferred(expiredNoticeOrder); setExpiredNoticeOrder(null); setSelectedOrderId(""); clearSavedPaymentOrderId(); }
  async function confirmCancelPayment() { if (!cancelNoticeOrder) return; await handleCancelOrder(cancelNoticeOrder); setCancelNoticeOrder(null); setSelectedOrderId(""); clearSavedPaymentOrderId(); onGoHome?.(); }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {expiredNoticeOrder && <div className="modal-backdrop"><div className="modal"><h2>Đã hết thời gian chuyển tiền</h2><p className="muted">Đơn <b>{expiredNoticeOrder.productCode}</b> đã quá thời gian thanh toán. Sản phẩm sẽ được mở lại nếu bạn chưa chuyển tiền.</p><p className="muted">Nếu bạn vừa chuyển khoản xong, hãy bấm “Tôi đã chuyển rồi” để gửi thông báo cho shop.</p><div className="row" style={{ justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}><button className="btn secondary modal-home-btn" onClick={closeExpiredNotice}>Đã hiểu</button><button className="btn payment-confirm-btn" disabled={isBeyondGrace} style={{ opacity: isBeyondGrace ? .55 : 1, cursor: isBeyondGrace ? "not-allowed" : "pointer" }} onClick={confirmTransferredAfterExpired}>Tôi đã chuyển rồi</button></div></div></div>}
      {cancelNoticeOrder && <div className="modal-backdrop"><div className="modal"><h2>Xác nhận hủy đơn</h2><p>Bạn chắc chắn muốn hủy đơn <b>{cancelNoticeOrder.productCode}</b>?</p><p className="muted">Sau khi hủy, sản phẩm sẽ được mở lại để bạn hoặc khách khác có thể mua.</p><div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}><button className="btn secondary" onClick={() => setCancelNoticeOrder(null)}>Không hủy</button><button className="btn payment-cancel-btn" onClick={confirmCancelPayment}>Hủy đơn</button></div></div></div>}
      {orderToShow ? <section className="payment-layout"><div className="card" style={{ padding: 12 }}><h2 style={{ marginBottom: 8 }}>Thông tin thanh toán</h2><div className="payment-info"><InfoLine label="ID sản phẩm" value={orderToShow.productCode} /><InfoLine label="SĐT" value={orderToShow.buyerPhone || "-"} /><InfoLine label="Giá sản phẩm" value={money(orderToShow.productPrice)} /><InfoLine label="Phí ship" value={money(orderToShow.shippingFee)} />{Number(orderToShow.shippingFee || 0) > 0 && <p className="shipping-note">Đơn đầu tiên được cộng thêm 20.000đ phí ship.</p>}<InfoLine label="Tổng cần chuyển" value={money(orderToShow.amount)} highlight /><InfoLine label="Nội dung CK" value={createTransferContent(orderToShow)} /></div><div className="payment-manual"><p className="payment-manual-title">Thông tin chuyển khoản thủ công</p><div className="payment-manual-grid"><span>Ngân hàng: <b>{BANK_CONFIG.id}</b></span><span>Số tài khoản: <b>{BANK_CONFIG.account}</b></span><span>Chủ tài khoản: <b>{BANK_CONFIG.owner}</b></span></div></div><div className="payment-confirm-row"><button className="btn payment-cancel-btn" disabled={isBeyondGrace} style={{ opacity: isBeyondGrace ? .55 : 1, cursor: isBeyondGrace ? "not-allowed" : "pointer" }} onClick={() => !isBeyondGrace && setCancelNoticeOrder(orderToShow)}>Hủy</button><button className="btn payment-confirm-btn" disabled={isBeyondGrace} style={{ opacity: isBeyondGrace ? .55 : 1, cursor: isBeyondGrace ? "not-allowed" : "pointer" }} onClick={() => !isBeyondGrace && handleConfirmTransferred(orderToShow)}>Đã thanh toán</button></div></div><div className="qr-wrap"><img src={createVietQrUrl(orderToShow)} alt="Mã QR chuyển khoản" /><div className="qr-timer">{countdown(secondsLeft)}</div><p className="qr-note">Vui lòng chuyển khoản trong thời gian mã QR có hiệu lực</p>{Number(orderToShow.shippingFee || 0) > 0 && <p className="shipping-note">Đơn đầu tiên được cộng thêm 20.000đ phí ship.</p>}</div></section> : <section className="card"><p className="muted">Chưa có đơn đang chờ thanh toán.</p></section>}
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
  const availableProducts = products.filter((product) => getDisplayProductStatus(product) === "available").length;
  const soldProducts = products.filter((product) => getDisplayProductStatus(product) === "sold").length;
  const unpackedCount = packingOrders.filter((group) => !group.packed).length;

  if (!adminUnlocked) {
    return (
      <section className="card admin-login-card">
        <div className="admin-login-icon">ĐL</div>
        <h2>Đăng nhập admin</h2>
        <p className="muted">Nhập mã PIN để vào quản lý. Mã demo: 123456</p>
        <input className="input" type="password" value={pin} onChange={(event) => setPin(event.target.value)} placeholder="Mã admin" onKeyDown={(event) => event.key === "Enter" && loginAdmin()} />
        <button className="btn admin-primary-btn" style={{ marginTop: 10, width: "100%" }} onClick={loginAdmin}>Vào admin</button>
      </section>
    );
  }

  const adminTabs = (
    <section className="admin-tabs-card">
      <button className={adminScreen === "main" ? "admin-tab active" : "admin-tab"} onClick={() => setAdminScreen("main")}>
        <span>Quản lý</span>
        <b>{activeOrders.length}</b>
      </button>
      <button className={adminScreen === "packing" ? "admin-tab active" : "admin-tab"} onClick={() => setAdminScreen("packing")}>
        <span>Đóng hàng</span>
        <b>{unpackedCount}</b>
      </button>
    </section>
  );

  if (adminScreen === "packing") {
    return (
      <div className="admin-page">
        <section className="admin-hero">
          <div>
            <p className="admin-kicker">Admin</p>
            <h2>Đóng hàng</h2>
            <p>Gộp đơn đã chốt theo số điện thoại để đóng hàng nhanh hơn.</p>
          </div>
        </section>
        {adminTabs}
        <PackingView packingOrders={packingOrders} onTogglePacked={handleTogglePackedByPhone} onRequestDeleteOrder={requestDeletePackingOrder} onRequestDeleteAll={requestDeleteAllPackingOrders} />
      </div>
    );
  }

  return (
    <div className="admin-page">
      <section className="admin-hero">
        <div>
          <p className="admin-kicker">Admin</p>
          <h2>Quản lý đơn hàng</h2>
          <p>Theo dõi đơn chờ xác nhận, sản phẩm và thời gian giữ đơn.</p>
        </div>
      </section>

      {adminTabs}

      <section className="admin-stats">
        <div className="admin-stat-card">
          <span>Tổng sản phẩm</span>
          <b>{products.length}</b>
          <p>{availableProducts} còn hàng</p>
        </div>
        <div className="admin-stat-card warning">
          <span>Chờ xác nhận</span>
          <b>{activeOrders.length}</b>
          <p>Khách đã báo thanh toán</p>
        </div>
        <div className="admin-stat-card success">
          <span>Đã chốt</span>
          <b>{closedOrders.length}</b>
          <p>{unpackedCount} kiện chưa đóng</p>
        </div>
        <div className="admin-stat-card muted-card">
          <span>Đã bán</span>
          <b>{soldProducts}</b>
          <p>Sản phẩm đang hết hàng</p>
        </div>
      </section>

      <div className="admin-grid-modern">
        <section className="card admin-panel admin-form-panel">
          <div className="admin-section-heading">
            <div>
              <h2>{productForm.editingId ? "Sửa sản phẩm" : "Thêm sản phẩm"}</h2>
              <p className="muted">Nhập giá dạng 120 = 120.000đ</p>
            </div>
          </div>

          <div className="admin-setting-card">
            <span>Thời gian giữ đơn</span>
            <div className="row">
              <input className="input" type="number" min="1" max="30" value={settings.paymentMinutes} onChange={(event) => handleUpdatePaymentMinutes(event.target.value)} />
              <b>phút</b>
            </div>
          </div>

          <form onSubmit={handleAddProduct} className="admin-product-form">
            <label>
              <span>ID sản phẩm</span>
              <input className="input" value={productForm.idCode} onChange={(event) => setProductForm({ ...productForm, idCode: event.target.value })} placeholder="VD: A001" />
            </label>
            <label>
              <span>Giá sản phẩm</span>
              <input className="input" value={productForm.price} onChange={(event) => setProductForm({ ...productForm, price: event.target.value })} placeholder="VD: 120" type="number" inputMode="numeric" />
            </label>
            {productForm.price && <p className="admin-price-preview">Giá hiển thị: <b>{money(Number(productForm.price || 0) * 1000)}</b></p>}
            <button className="btn admin-primary-btn" style={{ width: "100%" }}>{productForm.editingId ? "Lưu chỉnh sửa" : "Thêm sản phẩm"}</button>
            {productForm.editingId && <button type="button" className="btn secondary" style={{ width: "100%" }} onClick={cancelEditProduct}>Hủy sửa</button>}
          </form>
        </section>

        <div className="admin-main-column">
          <section className="card admin-panel">
            <div className="admin-section-heading">
              <div>
                <h2>Đơn đang chờ</h2>
                <p className="muted">Các đơn khách đã bấm “Đã thanh toán”.</p>
              </div>
              <span className="admin-count-badge">{activeOrders.length}</span>
            </div>

            {activeOrders.length === 0 ? (
              <div className="admin-empty-state">Chưa có đơn đang chờ xác nhận.</div>
            ) : (
              <div className="admin-order-list">
                {activeOrders.map((order) => (
                  <article key={order.id} className="admin-order-card">
                    <div className="admin-order-top">
                      <div>
                        <span className="admin-order-label">ID sản phẩm</span>
                        <h3>{order.productCode}</h3>
                      </div>
                      <span className={statusClass(order.status)}>{statusLabel(order.status)}</span>
                    </div>
                    <div className="admin-order-info">
                      <p><span>IG</span><b>{order.buyerIg || "-"}</b></p>
                      <p><span>Họ tên</span><b>{order.buyerFullName || "-"}</b></p>
                      <p><span>SĐT</span><b>{order.buyerPhone || "-"}</b></p>
                      <p><span>Tổng tiền</span><b>{money(order.amount)}</b></p>
                    </div>
                    <div className="admin-address-box">Địa chỉ cũ: <b>{order.buyerOldAddress || "-"}</b></div>
                    <div className="admin-card-actions">
                      <button className="btn success" onClick={() => handleConfirmPaid(order)}>Đã nhận tiền</button>
                      <button className="btn danger" onClick={() => handleCancelOrder(order)}>Hủy</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="card admin-panel admin-closed-panel">
            <button className="admin-collapsible-head" onClick={() => setShowAdminClosedOrders((value) => !value)}>
              <div>
                <h2>Đơn đã chốt</h2>
                <p>{closedOrders.length ? closedOrders.slice(0, 6).map((order) => order.productCode).join(" · ") : "Chưa có đơn nào được chốt"}</p>
              </div>
              <span className="status available">{showAdminClosedOrders ? "Ẩn" : "Xem"} {closedOrders.length}</span>
            </button>
            {showAdminClosedOrders && (
              <div className="admin-closed-list">
                {closedOrders.map((order) => (
                  <div key={order.id} className="admin-closed-item">
                    <div>
                      <b>ID: {order.productCode} · {money(order.amount)}</b>
                      <p>{order.isManualSold ? "Chốt thủ công từ sản phẩm" : `${order.buyerIg || "-"} · ${order.buyerFullName || "-"} · ${order.buyerPhone || "-"}`}</p>
                    </div>
                    <span className="status available">Đã chốt</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card admin-panel">
            <div className="admin-section-heading">
              <div>
                <h2>Sản phẩm</h2>
                <p className="muted">Quản lý trạng thái sản phẩm trên trang khách.</p>
              </div>
              <span className="admin-count-badge">{adminVisibleProducts.length}</span>
            </div>
            <div className="row" style={{ marginBottom: 12 }}>
              <div className="search-box">
                <SearchIcon />
                <input className="input search-input" value={adminProductSearch} onChange={(event) => setAdminProductSearch(event.target.value)} placeholder="Tìm sản phẩm, ví dụ A001..." />
              </div>
              {adminProductSearch && <button className="btn secondary small" onClick={() => setAdminProductSearch("")}>Xóa</button>}
            </div>

            <div className="admin-products-grid">
              {adminVisibleProducts.map((product) => {
                const displayStatus = getDisplayProductStatus(product);
                return (
                  <article key={product.id} className="admin-product-card">
                    <p>ID sản phẩm</p>
                    <h3>{product.idCode}</h3>
                    <b>{money(product.price)}</b>
                    <span className={statusClass(displayStatus)}>{statusLabel(displayStatus)}</span>
                    <div className="admin-product-actions">
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
    </div>
  );
}

function PackingView({ packingOrders, onTogglePacked, onRequestDeleteOrder, onRequestDeleteAll }) {
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