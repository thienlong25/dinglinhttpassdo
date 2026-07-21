import React, { useEffect, useMemo, useState } from "react";
import { collection, doc, getDocs, increment, onSnapshot,limit, orderBy, query, runTransaction, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import { db } from "./firebase";
import * as XLSX from "xlsx";

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

const ADMIN_PRODUCTS_PER_PAGE = 4;
const ADMIN_MAIN_ORDERS_LIMIT = 200;
const ADMIN_PACKING_ORDERS_LIMIT = 200;
const ADMIN_CONFIRM_ORDERS_LIMIT = 100;
const CUSTOMER_ORDERS_LIMIT = 30;
const PRODUCT_SEARCH_DEBOUNCE_MS = 350;
const PACKING_ITEMS_PER_PAGE = 4;

const SHIPPING_TEMPLATE_HEADERS = [
  "*Mã đơn hàng",
  "*Tên người nhận",
  "*Số điện thoại",
  "*Tỉnh/Thành Phố",
  "*Quận/Huyện",
  "*Xã/Phường",
  "*Địa chỉ chi tiết",
  "Lưu ý về địa chỉ",
  "Mã bưu chính",
  "*Tên sản phẩm",
  "Số lượng (Thông tin bắt buộc khi chọn Giao hàng một phần & Thu COD)",
  "Giá tiền (Thông tin bắt buộc khi chọn Giao hàng một phần & Thu COD)",
  "*Tổng cân nặng bưu gửi (KG)",
  "Chiều dài (CM)",
  "Chiều rộng (CM)",
  "Chiều cao (CM)",
  "Mã khách hàng",
  "*Giá trị đơn hàng",
  "*Giao hàng một phần (Y/N)",
  "*Cho phép thử hàng (Y/N)",
  "*Cho xem hàng, không cho thử (Y/N)",
  "Thu phí từ chối nhận hàng (Y/N)",
  "Phí từ chối nhận hàng cần thu",
  "*Thu COD (Y/N)",
  "Số tiền COD",
];

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

    if (!raw)
      return {
        buyerIg: "",
        buyerFullName: "",
        buyerPhone: "",
        buyerProvince: "",
        buyerDistrict: "",
        buyerWard: "",
        buyerAddress: "",
      };

    const parsed = JSON.parse(raw);

    return {
      buyerIg: parsed.buyerIg || "",
      buyerFullName: parsed.buyerFullName || "",
      buyerPhone: parsed.buyerPhone || "",
      buyerProvince: parsed.buyerProvince || "",
      buyerDistrict: parsed.buyerDistrict || "",
      buyerWard: parsed.buyerWard || "",
      buyerAddress: parsed.buyerAddress || "",
    };
  } catch {
    return {
      buyerIg: "",
      buyerFullName: "",
      buyerPhone: "",
      buyerProvince: "",
      buyerDistrict: "",
      buyerWard: "",
      buyerAddress: "",
    };
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
  if (address.trim().length < 8) return "Địa chỉ chi tiết nên được nhập rõ hơn.";
  return "";
}

function statusLabel(status) {
  const map = {
    available: "Còn hàng",
    reserved: "Chờ thanh toán",
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

function getProductIdNumber(idCode) {
  const digits = String(idCode || "").replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

function normalizeProductId(value) {
  return String(value || "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
}

function isNumericSearch(value) {
  return /^\d+$/.test(String(value || "").trim());
}


function getProductStatusQueryValues(statusFilter) {
  if (statusFilter === "available") return ["available"];
  if (statusFilter === "sold") return ["sold"];
  if (statusFilter === "reserved") return ["reserved", "customer_payment", "pending_payment", "waiting_confirm"];
  return [];
}

function addStatusFilterConstraint(constraints, statusFilter) {
  const values = getProductStatusQueryValues(statusFilter);
  if (values.length === 1) constraints.push(where("status", "==", values[0]));
  if (values.length > 1) constraints.push(where("status", "in", values));
}


const PRODUCT_STATS_COLLECTION = "stats";
const PRODUCT_STATS_DOC_ID = "main";

function emptyProductStats() {
  return {
    totalProducts: 0,
    availableProducts: 0,
    reservedProducts: 0,
    soldProducts: 0,
  };
}

function getProductStatsField(status) {
  const displayStatus = getDisplayProductStatus({ status });
  if (displayStatus === "available") return "availableProducts";
  if (displayStatus === "sold") return "soldProducts";
  if (["reserved", "customer_payment", "pending_payment", "waiting_confirm"].includes(displayStatus)) return "reservedProducts";
  return "reservedProducts";
}

function applyProductStatsDelta(batch, delta = {}) {
  const cleanDelta = {};
  ["totalProducts", "availableProducts", "reservedProducts", "soldProducts"].forEach((key) => {
    const value = Number(delta[key] || 0);
    if (value) cleanDelta[key] = increment(value);
  });
  if (!Object.keys(cleanDelta).length) return;
  batch.set(
    doc(db, PRODUCT_STATS_COLLECTION, PRODUCT_STATS_DOC_ID),
    {
      ...cleanDelta,
      updatedAt: Date.now(),
    },
    { merge: true }
  );
}

function applyProductStatusStatsDelta(batch, fromStatus, toStatus) {
  const fromField = getProductStatsField(fromStatus);
  const toField = getProductStatsField(toStatus);
  if (fromField === toField) return;
  applyProductStatsDelta(batch, { [fromField]: -1, [toField]: 1 });
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
    if (String(path).toLowerCase().startsWith("/payment")) {
      window.setTimeout(() => window.scrollTo({ top: 0, behavior: "auto" }), 0);
    }
  }

  useEffect(() => {
    if (mode === "payment") {
      window.setTimeout(() => window.scrollTo({ top: 0, behavior: "auto" }), 0);
    }
  }, [mode]);

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
  const [productStats, setProductStats] = useState(emptyProductStats);

  const savedCustomerInfo = useMemo(() => getSavedCustomerInfo(), []);
  const [buyerIg, setBuyerIg] = useState(savedCustomerInfo.buyerIg);
  const [buyerFullName, setBuyerFullName] = useState(savedCustomerInfo.buyerFullName);
  const [buyerPhone, setBuyerPhone] = useState(savedCustomerInfo.buyerPhone);
  const [buyerProvince, setBuyerProvince] = useState(savedCustomerInfo.buyerProvince);
const [buyerDistrict, setBuyerDistrict] = useState(savedCustomerInfo.buyerDistrict);

const [buyerWard, setBuyerWard] = useState(savedCustomerInfo.buyerWard);

const [buyerAddress, setBuyerAddress] = useState(savedCustomerInfo.buyerAddress);
  const [showBuyerForm, setShowBuyerForm] = useState(true);

  const [selectedOrderId, setSelectedOrderId] = useState(getSavedPaymentOrderId);
  const [instantPaymentOrder, setInstantPaymentOrder] = useState(null);
  const [search, setSearch] = useState("");
  const [shopProductsLoading, setShopProductsLoading] = useState(false);
  const [adminProductPage, setAdminProductPage] = useState(1);
  const [adminProductPageCursors, setAdminProductPageCursors] = useState([]);
  const [adminProductHasNextPage, setAdminProductHasNextPage] = useState(false);
  const [adminProductsLoading, setAdminProductsLoading] = useState(false);
  const [productForm, setProductForm] = useState({ idCode: "", price: "", editingId: "" });
  const [adminProductSearch, setAdminProductSearch] = useState("");
  const [adminStatusFilter, setAdminStatusFilter] = useState("all");
  const [showClosedOrders, setShowClosedOrders] = useState(false);
  const [showAdminClosedOrders, setShowAdminClosedOrders] = useState(false);
  const [adminScreen, setAdminScreen] = useState("main");
  const [toast, setToast] = useState("");
  const [now, setNow] = useState(Date.now());
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [adminBulkDeleteTarget, setAdminBulkDeleteTarget] = useState(null);
  const [packingDeleteTarget, setPackingDeleteTarget] = useState(null);
  const [transferNoticeOrder, setTransferNoticeOrder] = useState(null);
  const [buyingProductId, setBuyingProductId] = useState("");
  const [customerCancelTarget, setCustomerCancelTarget] = useState(null);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");

  useEffect(() => {
    const handleVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
useEffect(() => {
  saveCustomerInfo({
    buyerIg,
    buyerFullName,
    buyerPhone,
    buyerProvince,
    buyerDistrict,
    buyerWard,
    buyerAddress,
  });
}, [
  buyerIg,
  buyerFullName,
  buyerPhone,
  buyerProvince,
  buyerDistrict,
  buyerWard,
  buyerAddress,
]);

  const selectedOrder = orders.find((order) => order.id === selectedOrderId) || (instantPaymentOrder?.id === selectedOrderId ? instantPaymentOrder : null);
  const phoneError = phoneValidationMessage(buyerPhone);
const fullAddress = [
  buyerAddress,
  buyerWard,
  buyerDistrict,
  buyerProvince,
]
.filter(Boolean)
.join(", ");

const addressError = addressValidationMessage(fullAddress);

  function showMessage(message) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  useEffect(() => {
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
      unsubSettings();
    };
  }, []);

  useEffect(() => {
    if (!(mode === "admin" && adminUnlocked)) return undefined;
    const unsubStats = onSnapshot(
      doc(db, PRODUCT_STATS_COLLECTION, PRODUCT_STATS_DOC_ID),
      (snapshot) => {
        if (!snapshot.exists()) {
          setProductStats(emptyProductStats());
          return;
        }
        setProductStats({ ...emptyProductStats(), ...snapshot.data() });
      },
      (error) => {
        console.error("Lỗi đọc thống kê sản phẩm:", error);
        showMessage("Không đọc được thống kê sản phẩm.");
      }
    );
    return () => unsubStats();
  }, [mode, adminUnlocked]);

  async function rebuildProductStats() {
    try {
      const snapshot = await getDocs(collection(db, "products"));
      const nextStats = emptyProductStats();
      snapshot.docs.forEach((item) => {
        const data = item.data();
        nextStats.totalProducts += 1;
        const field = getProductStatsField(data.status || "available");
        nextStats[field] += 1;
      });
      await setDoc(doc(db, PRODUCT_STATS_COLLECTION, PRODUCT_STATS_DOC_ID), {
        ...nextStats,
        rebuiltAt: Date.now(),
        updatedAt: Date.now(),
      }, { merge: true });
      setProductStats(nextStats);
      showMessage("Đã đồng bộ lại thống kê toàn bộ sản phẩm.");
    } catch (error) {
      console.error("Lỗi đồng bộ thống kê:", error);
      showMessage("Không đồng bộ được thống kê sản phẩm.");
    }
  }

  // idNumber is written when products are created or edited.
  // Avoid scanning hundreds of products automatically on every admin login.

  useEffect(() => {
    setAdminProductPage(1);
    setAdminProductPageCursors([]);
  }, [adminProductSearch, adminStatusFilter]);

  useEffect(() => {
    const isAdminProductsView = mode === "admin" && adminUnlocked;
    const isShopProductsView = mode === "shop";

    if (!pageVisible || (!isAdminProductsView && !isShopProductsView)) {
      if (!isAdminProductsView && !isShopProductsView) setProducts([]);
      setShopProductsLoading(false);
      setAdminProductsLoading(false);
      return undefined;
    }

    const rawSearch = (isAdminProductsView ? adminProductSearch : search).trim();
    const cleanSearch = normalizeProductId(rawSearch);
    if (!cleanSearch) {
      setProducts([]);
      return undefined;
    }

    let unsubscribe = null;
    const timer = window.setTimeout(() => {
      const productsQuery = query(
        collection(db, "products"),
        where("idNumber", "==", Number(cleanSearch)),
        limit(1)
      );

      unsubscribe = onSnapshot(
        productsQuery,
        (snapshot) => {
          const list = snapshot.docs
            .map((item) => ({ id: item.id, ...item.data() }))
            .filter((product) => normalizeProductId(product.idCode) === cleanSearch);
          setProducts(list);
        },
        (error) => {
          console.error("Lỗi đọc products:", error);
          setProducts([]);
          showMessage("Không đọc được sản phẩm từ Firebase.");
        }
      );
    }, PRODUCT_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      if (unsubscribe) unsubscribe();
    };
  }, [mode, adminUnlocked, pageVisible, search, adminProductSearch]);

  function goToPrevAdminProductPage() {
    setAdminProductPage((value) => Math.max(1, value - 1));
  }

  function goToNextAdminProductPage() {
    if (!adminProductHasNextPage) return;
    setAdminProductPage((value) => value + 1);
  }

  useEffect(() => {
    if (!pageVisible) return undefined;

    const normalizedPhoneForOrders = normalizePhone(buyerPhone);
    let ordersRef;

    if (mode === "admin" && adminUnlocked) {
      if (adminScreen === "packing") {
        ordersRef = query(
          collection(db, "orders"),
          where("status", "==", "paid"),
          limit(ADMIN_PACKING_ORDERS_LIMIT)
        );
      } else if (adminScreen === "confirming") {
        ordersRef = query(
          collection(db, "orders"),
          where("status", "==", "waiting_confirm"),
          limit(ADMIN_CONFIRM_ORDERS_LIMIT)
        );
      } else {
        // Main admin only needs confirmed sales for the packing badge and orders awaiting confirmation.
        ordersRef = query(
          collection(db, "orders"),
          where("status", "in", ["waiting_confirm", "paid"]),
          limit(ADMIN_MAIN_ORDERS_LIMIT)
        );
      }
    } else if (normalizedPhoneForOrders) {
      ordersRef = query(
        collection(db, "orders"),
        where("buyerPhone", "==", normalizedPhoneForOrders),
        limit(CUSTOMER_ORDERS_LIMIT)
      );
    } else if (selectedOrderId) {
      ordersRef = doc(db, "orders", selectedOrderId);
    } else {
      setOrders([]);
      return undefined;
    }

    const unsubOrders = onSnapshot(
      ordersRef,
      (snapshot) => {
        const docs = snapshot.docs ? snapshot.docs : snapshot.exists() ? [snapshot] : [];
        const list = docs.map((item) => ({ id: item.id, ...item.data() }));
        list.sort((a, b) => Number(b.createdAt || b.closedAt || 0) - Number(a.createdAt || a.closedAt || 0));
        setOrders(list);
      },
      (error) => {
        console.error("Lỗi đọc orders:", error);
        showMessage("Không đọc được đơn hàng từ Firebase.");
      }
    );

    return () => unsubOrders();
  }, [mode, adminUnlocked, adminScreen, pageVisible, buyerPhone, selectedOrderId]);

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
    if (
 !buyerIg.trim() ||
 !buyerFullName.trim() ||
 !buyerPhone.trim() ||
 !buyerProvince.trim() ||
 !buyerDistrict.trim() ||
 !buyerWard.trim() ||
 !buyerAddress.trim()
) {
      showMessage("Vui lòng nhập đầy đủ Tên IG, Họ tên, SĐT, địa chỉ chi tiết, phường/xã, quận/huyện và tỉnh/thành phố.");
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
    let buyerOrdersForDecision = orders.filter((order) => normalizePhone(order.buyerPhone) === normalizedBuyerPhone);

    try {
      const buyerOrdersSnapshot = await getDocs(query(collection(db, "orders"), where("buyerPhone", "==", normalizedBuyerPhone), limit(CUSTOMER_ORDERS_LIMIT)));
      buyerOrdersForDecision = buyerOrdersSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    } catch (error) {
      console.warn("Không đọc nhanh được đơn theo SĐT, dùng dữ liệu đang có:", error);
    }

    const existingPaymentOrder = buyerOrdersForDecision.find(
      (order) =>
        ["customer_payment", "pending_payment"].includes(order.status) &&
        (!order.expiredAt || order.expiredAt + PAYMENT_EXPIRED_GRACE_MS > now)
    );

    if (existingPaymentOrder) {
      setSelectedOrderId(existingPaymentOrder.id);
      savePaymentOrderId(existingPaymentOrder.id);
      showMessage("Bạn đang có đơn cần thanh toán, hãy thanh toán hoặc hủy đơn đó để mua đơn này");
      return;
    }

    const isFirstOrderForBuyer = !buyerOrdersForDecision.some((order) => ["paid", "waiting_confirm", "customer_payment", "pending_payment"].includes(order.status));
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
          buyerAddress: buyerAddress.trim(),
          buyerWard: buyerWard.trim(),
          buyerDistrict: buyerDistrict.trim(),
          buyerProvince: buyerProvince.trim(),
          buyerFullAddress: fullAddress,
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
        transaction.set(doc(db, PRODUCT_STATS_COLLECTION, PRODUCT_STATS_DOC_ID), {
          availableProducts: increment(-1),
          reservedProducts: increment(1),
          updatedAt: Date.now(),
        }, { merge: true });
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

      setInstantPaymentOrder(createdOrder);
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
      if (instantPaymentOrder?.id === order.id) {
        setInstantPaymentOrder(null);
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
      applyProductStatusStatsDelta(batch, "waiting_confirm", "sold");
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
      applyProductStatusStatsDelta(batch, order.status || "waiting_confirm", "available");
      if (order.buyerPhone) {
        batch.delete(doc(db, ACTIVE_PAYMENT_LOCK_COLLECTION, normalizePhone(order.buyerPhone)));
      }
      await batch.commit();

      if (selectedOrderId === order.id) {
        setSelectedOrderId("");
        clearSavedPaymentOrderId();
      }
      if (instantPaymentOrder?.id === order.id) {
        setInstantPaymentOrder(null);
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

        if (order.productId) {
          batch.update(doc(db, "products", order.productId), {
            status: "available",
            reservedUntil: null,
            updatedAt: Date.now(),
          });
          applyProductStatusStatsDelta(batch, order.status || "customer_payment", "available");
        }
      });

      await batch.commit();
    };

    markExpired().catch((error) => {
      console.error("Lỗi cập nhật đơn hết hạn:", error);
    });
  }, [now, orders]);

  async function handleAddProduct(event) {
    event.preventDefault();
    const idCode = productForm.idCode.replace(/\D/g, "");
    const rawPrice = Number(productForm.price || 0);
    const price = rawPrice * 1000;
    if (!idCode || !rawPrice) {
      showMessage("Nhập ID và giá sản phẩm.");
      return;
    }
    try {
      const duplicateSnapshot = await getDocs(query(collection(db, "products"), where("idCode", "==", idCode), limit(2)));
      const duplicate = duplicateSnapshot.docs.some((item) => item.id !== productForm.editingId);
      if (duplicate) {
        showMessage("ID sản phẩm đã tồn tại.");
        return;
      }

      if (productForm.editingId) {
        const batch = writeBatch(db);
        batch.update(doc(db, "products", productForm.editingId), {
          idCode,
          idNumber: getProductIdNumber(idCode),
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
        const batch = writeBatch(db);
        batch.set(doc(db, "products", productId), {
          id: productId,
          idCode,
          idNumber: getProductIdNumber(idCode),
          price,
          status: "available",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        applyProductStatsDelta(batch, { totalProducts: 1, availableProducts: 1 });
        await batch.commit();
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
      applyProductStatsDelta(batch, { totalProducts: -1, [getProductStatsField(product.status || "available")]: -1 });

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

  function requestDeleteAdminProducts(productsToDelete) {
    const list = Array.isArray(productsToDelete) ? productsToDelete.filter(Boolean) : [];
    if (!list.length) {
      showMessage("Không có sản phẩm nào để xóa.");
      return;
    }
    setAdminBulkDeleteTarget({ products: list });
  }

  async function confirmDeleteAdminProducts() {
    const list = adminBulkDeleteTarget?.products || [];
    if (!list.length) return;

    try {
      const productIds = new Set(list.map((product) => product.id));
      const batch = writeBatch(db);

      const bulkStatsDelta = { totalProducts: -list.length };
      list.forEach((product) => {
        batch.delete(doc(db, "products", product.id));
        const field = getProductStatsField(product.status || "available");
        bulkStatsDelta[field] = Number(bulkStatsDelta[field] || 0) - 1;
      });
      applyProductStatsDelta(batch, bulkStatsDelta);

      orders
        .filter((order) => productIds.has(order.productId) && ["customer_payment", "pending_payment", "waiting_confirm"].includes(order.status))
        .forEach((order) => {
          batch.update(doc(db, "orders", order.id), {
            status: "cancelled",
            cancelledAt: Date.now(),
            updatedAt: Date.now(),
          });
          if (order.buyerPhone) {
            batch.delete(doc(db, ACTIVE_PAYMENT_LOCK_COLLECTION, normalizePhone(order.buyerPhone)));
          }
        });

      await batch.commit();
      setAdminBulkDeleteTarget(null);
      showMessage(`Đã xóa ${list.length} sản phẩm.`);
    } catch (error) {
      console.error("Lỗi xóa nhiều sản phẩm:", error);
      showMessage("Không xóa được toàn bộ sản phẩm đã chọn.");
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
        applyProductStatusStatsDelta(batch, product.status || "available", "available");

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
          buyerAddress: "",
          buyerWard: "",
          buyerDistrict: "",
          buyerProvince: "",
          buyerFullAddress: "",
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
        applyProductStatusStatsDelta(batch, product.status || "available", "sold");
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
  const customerWaitingConfirmOrders = orders.filter((order) => order.status === "waiting_confirm" && normalizedCurrentPhone && normalizePhone(order.buyerPhone) === normalizedCurrentPhone);
  const continuePaymentOrder = orders.find((order) => order.id === selectedOrderId && customerPaymentStatuses.includes(order.status) && (!order.expiredAt || order.expiredAt + PAYMENT_EXPIRED_GRACE_MS > now)) || (instantPaymentOrder && customerPaymentStatuses.includes(instantPaymentOrder.status) && (!instantPaymentOrder.expiredAt || instantPaymentOrder.expiredAt + PAYMENT_EXPIRED_GRACE_MS > now) ? instantPaymentOrder : null) || customerActiveOrders.find((order) => !order.expiredAt || order.expiredAt + PAYMENT_EXPIRED_GRACE_MS > now) || null;

  useEffect(() => {
    if (!instantPaymentOrder) return;
    const liveOrder = orders.find((order) => order.id === instantPaymentOrder.id);
    if (liveOrder && liveOrder.createdAt === instantPaymentOrder.createdAt) {
      setInstantPaymentOrder(null);
    }
  }, [orders, instantPaymentOrder]);

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
        html, body, #root { width: 100%; max-width: 100%; overflow-x: hidden; }
        body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--dark); }
        button, input, textarea, a { font: inherit; }
        a { color: inherit; text-decoration: none; }
        img, svg { max-width:100%; }
        input, button { min-width:0; }
        .app { min-height: 100vh; width:100%; max-width:100vw; overflow-x:hidden; padding: 14px; background: radial-gradient(circle at top left, rgba(179,235,242,.7), transparent 34%), linear-gradient(180deg,#f9fdff 0%,#eefbff 100%); }
        .shell { width:100%; max-width: 1180px; margin: 0 auto; overflow-x:hidden; }
        .header { position:relative; overflow:hidden; background: linear-gradient(135deg,#0f172a 0%,#164e63 55%,#B3EBF2 100%); color:white; border: 0; border-radius: 28px; padding: 18px; box-shadow: 0 18px 44px rgba(15,23,42,.18); margin-bottom: 16px; }
        .header::after { content:""; position:absolute; width:180px; height:180px; right:-54px; top:-70px; background:rgba(255,255,255,.22); border-radius:999px; }
        .header .muted { color:rgba(255,255,255,.78); }
        .title { display:flex; align-items:center; gap:10px; }
        .logo { width:54px; height:54px; border-radius:20px; background: rgba(255,255,255,.96); color:#0f172a; display:grid; place-items:center; font-weight:950; box-shadow:0 12px 30px rgba(15,23,42,.2); }
        h1 { font-size: 24px; margin:0; }
        h2 { font-size: 18px; margin:0 0 10px; }
        .muted { color: var(--muted); font-size: 13px; margin: 4px 0; }
        .row { display:flex; align-items:center; gap:8px; min-width:0; max-width:100%; }
        .between { display:flex; align-items:center; justify-content:space-between; gap:10px; min-width:0; max-width:100%; }
        .tabs { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
        .btn { border:0; background: linear-gradient(135deg,#B3EBF2,#8de1ee); color:#0f172a; border-radius: 16px; padding: 11px 15px; font-weight: 850; cursor:pointer; transition: .18s; box-shadow:0 10px 22px rgba(45,173,190,.16); }
        .btn:hover { transform: translateY(-1px); filter: brightness(.99); }
        .btn.secondary { background:rgba(255,255,255,.75); border:1px solid rgba(179,235,242,.9); box-shadow:none; }
        .btn.danger { background:#fee2e2; color:#991b1b; }
        .btn.success { background:#dcfce7; color:#166534; }
        .btn.small { padding: 7px 10px; border-radius: 12px; font-size: 13px; }
        .card { min-width:0; max-width:100%; background:rgba(255,255,255,.88); backdrop-filter: blur(12px); border:1px solid rgba(179,235,242,.75); border-radius: 26px; padding: 16px; box-shadow: 0 18px 42px rgba(15, 23, 42, .08); }
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
        .search-box { position:relative; flex:1 1 0; min-width:0; max-width:100%; }
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
        .payment-confirm-row { display:flex; justify-content:center; align-items:center; gap:10px; flex-wrap:wrap; }
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
        .payment-back-row { margin:0 0 10px; display:flex; justify-content:flex-start; }
        .compact-setting { display:grid; grid-template-columns: auto 80px auto; gap:8px; align-items:center; margin-bottom:12px; }
        .packing-list { display:grid; gap:12px; }
        .packing-toolbar { display:flex; align-items:center; gap:7px; flex-wrap:nowrap; overflow-x:auto; padding:7px; margin-bottom:12px; background:rgba(255,255,255,.72); border:1px solid rgba(179,235,242,.85); border-radius:18px; scrollbar-width:thin; }
        .packing-toolbar .filter-pill { flex:0 0 auto; padding:9px 11px; white-space:nowrap; }
        .packing-toolbar-icon { flex:0 0 auto; width:38px; height:38px; }
        .packing-products { display:grid; gap:8px; }
        .packing-product-item { position:relative; padding-right:42px !important; }
        .packing-delete-x { position:absolute; top:7px; right:7px; width:28px; height:28px; border-radius:999px; border:0; background:#fee2e2; color:#991b1b; font-size:19px; font-weight:900; line-height:1; cursor:pointer; display:grid; place-items:center; }
        .continue-payment-box { border:1px solid #fde68a; background:#fffbeb; border-radius:18px; padding:12px; }
        .customer-orders-card { padding:14px !important; border-color:rgba(73,190,209,.45); background:linear-gradient(180deg,#ffffff 0%,#f4fdff 100%); }
        .customer-orders-top { width:100%; border:0; background:transparent; padding:0; text-align:left; }
        .customer-orders-summary { margin-top:8px; display:flex; gap:8px; flex-wrap:wrap; }
        .customer-orders-chip { display:inline-flex; align-items:center; justify-content:center; border-radius:999px; padding:6px 10px; font-size:12px; font-weight:900; }
        .customer-orders-chip.waiting { background:#e0e7ff; color:#3730a3; }
        .customer-orders-chip.done { background:#dcfce7; color:#166534; }
        .customer-order-section { margin-top:12px; border-radius:18px; padding:12px; border:1px solid; }
        .customer-order-section.waiting { border-color:#c7d2fe; background:linear-gradient(180deg,#eef2ff,#f8faff); }
        .customer-order-section.done { border-color:#bbf7d0; background:linear-gradient(180deg,#f0fdf4,#fbfffc); }
        .customer-order-section-title { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:8px; }
        .customer-order-section-title b { font-size:16px; }
        .customer-order-count { border-radius:999px; padding:5px 9px; font-size:12px; font-weight:950; background:white; box-shadow:0 6px 14px rgba(15,23,42,.06); }
        .customer-order-item { border-radius:16px; padding:12px; margin-top:8px; background:white; box-shadow:0 10px 22px rgba(15,23,42,.06); border:1px solid rgba(255,255,255,.75); }
        .customer-order-id { font-size:18px; font-weight:950; margin:0 0 5px; }
        .customer-order-money { font-size:15px; font-weight:900; color:#0f172a; margin:0 0 4px; }
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
        .info-value { font-weight:850; text-align:right; min-width:0; overflow-wrap:anywhere; }
        .info-line.highlight { margin-top:4px; padding:12px 10px; border:1px solid var(--line); border-radius:14px; background:#f1fbfd; }
        .info-line.highlight span { color:#0f172a; font-weight:800; }
        .info-line.highlight .info-value { font-size:18px; }
        .payment-alert-header { background:transparent; color:#dc2626; border:3px solid #ef4444; box-shadow:none; padding:14px 16px; }
        .payment-alert-header::after { display:none; }
        .payment-alert-header .between { justify-content:center; }
        .payment-alert-header .title { width:100%; justify-content:center; }
        .payment-header-warning { margin:0; width:100%; color:#dc2626; font-size:21px; font-weight:950; line-height:1.35; text-align:center; text-transform:uppercase; text-shadow:none; }
        .payment-top-actions { display:flex; justify-content:center; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 14px; padding:10px; border-radius:18px; background:rgba(255,255,255,.92); border:1px solid rgba(179,235,242,.85); box-shadow:0 12px 28px rgba(15,23,42,.08); }
        .payment-top-actions .btn { min-height:46px; }
        @media (max-width:720px) {
          .payment-header-warning { font-size:16px; line-height:1.4; }
          .payment-view { padding-bottom:92px; }
          .payment-top-actions {
            position:fixed;
            z-index:45;
            left:10px;
            right:10px;
            bottom:max(10px, env(safe-area-inset-bottom));
            margin:0;
            padding:9px;
            flex-wrap:nowrap;
            border:1px solid rgba(148,163,184,.45);
            border-radius:18px;
            background:rgba(255,255,255,.96);
            backdrop-filter:blur(14px);
            box-shadow:0 16px 40px rgba(15,23,42,.24);
          }
          .payment-top-actions .btn { flex:1 1 0; min-width:0; min-height:50px; font-size:15px; }
        }
        .qr-wrap { border-radius:18px; background:linear-gradient(180deg,#ffffff 0%,#f7fdff 100%); }

        .admin-tabs { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:6px; background:rgba(255,255,255,.72); border:1px solid rgba(179,235,242,.85); border-radius:18px; margin-bottom:12px; }
        .admin-tab { border:0; border-radius:14px; padding:10px 12px; background:transparent; color:#475569; font-weight:900; cursor:pointer; }
        .admin-tab.active { background:linear-gradient(135deg,#0f172a,#164e63); color:white; box-shadow:0 12px 26px rgba(15,23,42,.14); }
        .admin-stats-row { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)) auto; gap:8px; margin-bottom:12px; align-items:stretch; }
        .admin-stat-action { display:flex; align-items:center; justify-content:center; }
        .admin-sync-btn { min-height:38px; padding:8px 10px; border-radius:12px; font-size:12px; white-space:nowrap; }
        .admin-stat { background:rgba(255,255,255,.9); border:1px solid rgba(179,235,242,.8); border-radius:14px; padding:9px 10px; box-shadow:0 8px 18px rgba(15,23,42,.04); min-width:0; }
        .admin-stat-label { margin:0 0 2px; color:var(--muted); font-size:11px; font-weight:850; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .admin-stat-value { margin:0; font-size:18px; font-weight:950; }
        .admin-main-grid { display:grid; grid-template-columns:minmax(235px, 300px) 1fr; gap:14px; align-items:start; }
        .admin-compact-setting { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
        .admin-compact-setting .input { max-width:74px; padding:8px 10px; border-radius:12px; text-align:center; }
        .admin-actions { display:flex; justify-content:center; gap:7px; flex-wrap:wrap; margin-top:12px; }
        .icon-btn { width:34px; height:34px; border-radius:12px; border:1px solid rgba(179,235,242,.9); background:#ffffff; display:inline-grid; place-items:center; cursor:pointer; font-size:16px; box-shadow:0 8px 16px rgba(15,23,42,.06); }
        .icon-btn:hover { transform:translateY(-1px); }
        .icon-btn.danger { background:#fee2e2; color:#991b1b; border-color:#fecaca; }
        .icon-btn.success { background:#dcfce7; color:#166534; border-color:#bbf7d0; }
        .icon-btn.warning { background:#fef9c3; color:#854d0e; border-color:#fde68a; }
        .admin-product-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
        .admin-product-toolbar .search-box { min-width:0; }
        .admin-product-card .product-code { font-size:30px; min-width:82px; }
        .admin-pending-summary-card { padding:14px; }
        .admin-pending-summary { width:100%; border:0; background:linear-gradient(135deg,#eefaff,#ffffff); border:1px solid rgba(179,235,242,.9); border-radius:20px; padding:14px; display:flex; align-items:center; justify-content:space-between; gap:12px; text-align:left; cursor:pointer; box-shadow:0 12px 26px rgba(15,23,42,.06); }
        .admin-pending-summary:hover { transform:translateY(-1px); box-shadow:0 18px 34px rgba(15,23,42,.1); }
        .admin-pending-count { min-width:74px; min-height:58px; border-radius:18px; background:#0f172a; color:white; display:grid; place-items:center; padding:8px; }
        .admin-pending-count b { font-size:24px; line-height:1; }
        .admin-pending-count span { font-size:11px; font-weight:800; opacity:.8; }
        .admin-confirm-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
        .admin-confirm-card { border:1px solid rgba(179,235,242,.85); background:#fff; border-radius:18px; padding:12px; box-shadow:0 10px 24px rgba(15,23,42,.05); }
        .admin-confirm-card + .admin-confirm-card { margin-top:10px; }
        .admin-confirm-grid { display:grid; grid-template-columns:1fr auto; gap:12px; align-items:start; }
        .admin-confirm-actions { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
        @media (max-width: 850px) { .admin-grid { grid-template-columns: 1fr !important; } .admin-main-grid { grid-template-columns:1fr !important; } .form-grid { grid-template-columns: 1fr !important; } .customer-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } .between { align-items: flex-start; } }
        @media (max-width: 720px) { .admin-confirm-grid { grid-template-columns:1fr; } .admin-confirm-actions { justify-content:flex-start; } .admin-stats-row { grid-template-columns:repeat(4, minmax(0, 1fr)); gap:6px; overflow:visible; } .admin-stat-action { grid-column:1 / -1; justify-content:flex-end; } .admin-sync-btn { min-height:32px; padding:6px 9px; font-size:11px; } .admin-stat { padding:7px 6px; border-radius:12px; } .admin-stat-label { font-size:9.5px; } .admin-stat-value { font-size:15px; } .admin-tabs { position:sticky; top:6px; z-index:5; } .app { padding:10px; } .header { border-radius:20px; } h1 { font-size:20px; } .grid-products { grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; } .product-code { font-size:28px; min-width:78px; padding:7px 10px; } .payment-layout { grid-template-columns: minmax(0, 1fr); } .qr-wrap { order:-1; } .tabs .btn { flex:1; } .filter-bar, .admin-product-toolbar { max-width:100%; overflow:hidden; } }
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

      {adminBulkDeleteTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Xác nhận xóa tất cả</h2>
            <p>Bạn chắc chắn muốn xóa <b>{adminBulkDeleteTarget.products.length}</b> sản phẩm đang hiển thị?</p>
            <p className="muted">Các đơn đang chờ liên quan đến những sản phẩm này sẽ bị hủy. Thao tác này không thể hoàn tác.</p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn secondary" onClick={() => setAdminBulkDeleteTarget(null)}>Không xóa</button>
              <button className="btn danger" onClick={confirmDeleteAdminProducts}>Xóa tất cả</button>
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
        {mode === "payment" && (
          <div className="payment-back-row">
            <button className="btn secondary back-arrow-btn" onClick={() => goTo("/")} aria-label="Quay lại trang khách" title="Quay lại trang khách">
              <span className="back-icon">←</span>
              <span className="back-text">Quay lại</span>
            </button>
          </div>
        )}

        <header className={`header ${mode === "payment" ? "payment-alert-header" : ""}`}>
          <div className="between">
            <div className="title">
              {mode !== "payment" && <div className="logo">ĐL</div>}
              <div>
                {mode === "payment" ? (
                  <h1 className="payment-header-warning">CK XONG TÍCH CHỌN ĐÃ THANH TOÁN VÀ GỬI BILL QUA IG</h1>
                ) : (
                  <>
                    <h1>Đinh Linh pass đồ</h1>
                    <p className="muted">Chốt đơn theo ID sản phẩm · QR MB tự động · Admin đóng hàng</p>
                  </>
                )}
              </div>
            </div>
            {adminUnlocked && <button className="btn secondary small" onClick={logoutAdmin}>Thoát admin</button>}
          </div>
          {mode !== "admin" && <div className="tabs" />}
        </header>

        {mode === "shop" && (
          <ShopView
            buyerIg={buyerIg}
            setBuyerIg={setBuyerIg}
            buyerFullName={buyerFullName}
            setBuyerFullName={setBuyerFullName}
            buyerPhone={buyerPhone}
            setBuyerPhone={setBuyerPhone}
            buyerProvince={buyerProvince}
            setBuyerProvince={setBuyerProvince}
            buyerDistrict={buyerDistrict}
            setBuyerDistrict={setBuyerDistrict}
            buyerWard={buyerWard}
            setBuyerWard={setBuyerWard}
            buyerAddress={buyerAddress}
            setBuyerAddress={setBuyerAddress}
            phoneError={phoneError}
            addressError={addressError}
            showBuyerForm={showBuyerForm}
            setShowBuyerForm={setShowBuyerForm}
            search={search}
            setSearch={setSearch}
            products={products}
            now={now}
            closedOrders={customerClosedOrders}
            waitingConfirmOrders={customerWaitingConfirmOrders}
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
            adminStatusFilter={adminStatusFilter}
            setAdminStatusFilter={setAdminStatusFilter}
            productPage={adminProductPage}
            productHasNextPage={adminProductHasNextPage}
            productLoading={adminProductsLoading}
            onProductPrevPage={goToPrevAdminProductPage}
            onProductNextPage={goToNextAdminProductPage}
            adminScreen={adminScreen}
            setAdminScreen={setAdminScreen}
            handleTogglePackedByPhone={handleTogglePackedByPhone}
            requestDeletePackingOrder={requestDeletePackingOrder}
            requestDeleteAllPackingOrders={requestDeleteAllPackingOrders}
            requestDeleteAdminProducts={requestDeleteAdminProducts}
            productStats={productStats}
            rebuildProductStats={rebuildProductStats}
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

function ShopView({ buyerIg, setBuyerIg, buyerFullName, setBuyerFullName, buyerPhone, setBuyerPhone, buyerProvince, setBuyerProvince, buyerDistrict, setBuyerDistrict, buyerWard, setBuyerWard, buyerAddress, setBuyerAddress, phoneError, addressError, showBuyerForm, setShowBuyerForm, search, setSearch, statusFilter, setStatusFilter, products, now, productPage = 1, productHasNextPage = false, productLoading = false, onProductPrevPage, onProductNextPage, closedOrders, waitingConfirmOrders = [], hasBuyerPhone, showClosedOrders, setShowClosedOrders, handleBuy, buyingProductId, continuePaymentOrder, onContinuePayment, onCancelContinuePayment }) {
  const [addressOptions, setAddressOptions] = useState({ provinces: [], districts: [], wards: [] });
  const [selectedProvinceCode, setSelectedProvinceCode] = useState("");
  const [selectedDistrictCode, setSelectedDistrictCode] = useState("");
  const [addressOptionsLoading, setAddressOptionsLoading] = useState(false);
  const [addressOptionsError, setAddressOptionsError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadProvinces() {
      setAddressOptionsLoading(true);
      setAddressOptionsError("");
      try {
        const response = await fetch("https://provinces.open-api.vn/api/v1/p/");
        if (!response.ok) throw new Error("PROVINCES_FETCH_FAILED");
        const provinces = await response.json();
        if (cancelled) return;
        setAddressOptions((current) => ({ ...current, provinces }));

        if (buyerProvince) {
          const savedProvince = provinces.find((item) => item.name === buyerProvince);
          if (savedProvince) setSelectedProvinceCode(String(savedProvince.code));
        }
      } catch (error) {
        console.error("Lỗi tải danh sách tỉnh/thành:", error);
        if (!cancelled) setAddressOptionsError("Không tải được danh sách địa chỉ. Vui lòng thử lại.");
      } finally {
        if (!cancelled) setAddressOptionsLoading(false);
      }
    }

    loadProvinces();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedProvinceCode) {
      setAddressOptions((current) => ({ ...current, districts: [], wards: [] }));
      setSelectedDistrictCode("");
      return undefined;
    }

    let cancelled = false;
    async function loadDistrictsAndWards() {
      setAddressOptionsLoading(true);
      setAddressOptionsError("");
      try {
        const response = await fetch(`https://provinces.open-api.vn/api/v1/p/${selectedProvinceCode}?depth=2`);
        if (!response.ok) throw new Error("DISTRICTS_FETCH_FAILED");
        const province = await response.json();
        if (cancelled) return;
        const districts = province.districts || [];
        setAddressOptions((current) => ({ ...current, districts, wards: [] }));

        const savedDistrict = districts.find((item) => item.name === buyerDistrict);
        setSelectedDistrictCode(savedDistrict ? String(savedDistrict.code) : "");
      } catch (error) {
        console.error("Lỗi tải danh sách quận/huyện:", error);
        if (!cancelled) setAddressOptionsError("Không tải được danh sách quận/huyện.");
      } finally {
        if (!cancelled) setAddressOptionsLoading(false);
      }
    }

    loadDistrictsAndWards();
    return () => { cancelled = true; };
  }, [selectedProvinceCode]);

  useEffect(() => {
    if (!selectedDistrictCode) {
      setAddressOptions((current) => ({ ...current, wards: [] }));
      return undefined;
    }

    let cancelled = false;

    async function loadWards() {
      setAddressOptionsLoading(true);
      setAddressOptionsError("");

      try {
        const response = await fetch(
          `https://provinces.open-api.vn/api/v1/d/${selectedDistrictCode}?depth=2`
        );
        if (!response.ok) throw new Error("WARDS_FETCH_FAILED");

        const district = await response.json();
        if (cancelled) return;

        const wards = district.wards || [];
        setAddressOptions((current) => ({ ...current, wards }));

        if (buyerWard) {
          const savedWard = wards.find((item) => item.name === buyerWard);
          if (!savedWard) setBuyerWard("");
        }
      } catch (error) {
        console.error("Lỗi tải danh sách phường/xã:", error);
        if (!cancelled) {
          setAddressOptions((current) => ({ ...current, wards: [] }));
          setAddressOptionsError("Không tải được danh sách phường/xã. Vui lòng thử lại.");
        }
      } finally {
        if (!cancelled) setAddressOptionsLoading(false);
      }
    }

    loadWards();
    return () => { cancelled = true; };
  }, [selectedDistrictCode]);

  function handleProvinceChange(event) {
    const code = event.target.value;
    const province = addressOptions.provinces.find((item) => String(item.code) === code);
    setSelectedProvinceCode(code);
    setSelectedDistrictCode("");
    setBuyerProvince(province?.name || "");
    setBuyerDistrict("");
    setBuyerWard("");
  }

  function handleDistrictChange(event) {
    const code = event.target.value;
    const district = addressOptions.districts.find((item) => String(item.code) === code);
    setSelectedDistrictCode(code);
    setBuyerDistrict(district?.name || "");
    setBuyerWard("");
  }

  function handleWardChange(event) {
    const code = event.target.value;
    const ward = addressOptions.wards.find((item) => String(item.code) === code);
    setBuyerWard(ward?.name || "");
  }

  const selectedWardCode = String(addressOptions.wards.find((item) => item.name === buyerWard)?.code || "");

  const sortedProducts = useMemo(() => {
    return [...products]
      .filter((product) => {
        const displayStatus = getDisplayProductStatus(product);
        if (statusFilter === "all") return true;
        if (statusFilter === "available") return displayStatus === "available";
        if (statusFilter === "reserved") return ["reserved", "customer_payment", "pending_payment", "waiting_confirm"].includes(displayStatus);
        if (statusFilter === "sold") return displayStatus === "sold";
        return true;
      })
      .sort((a, b) => getProductIdNumber(a.idCode) - getProductIdNumber(b.idCode));
  }, [products, statusFilter]);

  const pagedProducts = sortedProducts;

  return (
    <div className="payment-view" style={{ display: "grid", gap: 14 }}>
      <section className="card">
        <button className="between" style={{ width: "100%", border: 0, background: "transparent", padding: 0, textAlign: "left" }} onClick={() => setShowBuyerForm((value) => !value)}>
          <div><h2 style={{ marginBottom: 3 }}>Thông tin khách</h2><p className="muted">Vui lòng nhập đầy đủ thông tin nhận hàng. Tất cả các trường địa chỉ đều bắt buộc.</p></div>
          <span className="status available">{showBuyerForm ? "Ẩn" : "Nhập"}</span>
        </button>
        {showBuyerForm && (
          <div className="form-grid customer-form-grid" style={{ marginTop: 12 }}>
            <div><input className="input" value={buyerIg} onChange={(event) => setBuyerIg(event.target.value)} placeholder="Tên IG *" required /></div>
            <div><input className="input" value={buyerFullName} onChange={(event) => setBuyerFullName(event.target.value)} placeholder="Họ tên *" required /></div>
            <div><input className="input" value={buyerPhone} onChange={(event) => setBuyerPhone(event.target.value)} placeholder="SĐT *" inputMode="tel" required />{phoneError && <p className="field-error">{phoneError}</p>}</div>
            <div><input className="input" value={buyerAddress} onChange={(event) => setBuyerAddress(event.target.value)} placeholder="Địa chỉ chi tiết *" required /></div>
            <div>
              <select className="input" value={selectedProvinceCode} onChange={handleProvinceChange} required disabled={addressOptionsLoading && !addressOptions.provinces.length}>
                <option value="">Chọn Tỉnh/Thành phố *</option>
                {addressOptions.provinces.map((province) => <option key={province.code} value={province.code}>{province.name}</option>)}
              </select>
            </div>
            <div>
              <select className="input" value={selectedDistrictCode} onChange={handleDistrictChange} required disabled={!selectedProvinceCode || addressOptionsLoading}>
                <option value="">Chọn Quận/Huyện *</option>
                {addressOptions.districts.map((district) => <option key={district.code} value={district.code}>{district.name}</option>)}
              </select>
            </div>
            <div>
              <select className="input" value={selectedWardCode} onChange={handleWardChange} required disabled={!selectedDistrictCode || addressOptionsLoading}>
                <option value="">Chọn Phường/Xã *</option>
                {addressOptions.wards.map((ward) => <option key={ward.code} value={ward.code}>{ward.name}</option>)}
              </select>
              {addressOptionsError && <p className="field-error">{addressOptionsError}</p>}
              {addressError && <p className="field-error">{addressError}</p>}
            </div>
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

      <section className="card customer-orders-card">
        <button className="between customer-orders-top" onClick={() => setShowClosedOrders((value) => !value)}>
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 18 }}>Đơn của bạn</b>
            <p className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {!hasBuyerPhone ? "Nhập đúng SĐT để xem đơn của bạn" : "Theo dõi trạng thái đơn hàng của bạn tại đây"}
            </p>
            {hasBuyerPhone && (
              <div className="customer-orders-summary">
                <span className="customer-orders-chip waiting">Chờ xác nhận: {waitingConfirmOrders.length}</span>
                <span className="customer-orders-chip done">Đã chốt: {closedOrders.length}</span>
              </div>
            )}
          </div>
          <span className="status available">{showClosedOrders ? "Ẩn chi tiết" : "Xem chi tiết"}</span>
        </button>
        {showClosedOrders && (
          <div style={{ marginTop: 10 }}>
            {!hasBuyerPhone ? (
              <p className="muted">Nhập đúng SĐT để xem đơn của bạn.</p>
            ) : (
              <>
                <div className="customer-order-section waiting">
                  <div className="customer-order-section-title">
                    <b>Đơn chờ xác nhận</b>
                    <span className="customer-order-count">{waitingConfirmOrders.length} đơn</span>
                  </div>
                  {waitingConfirmOrders.length ? (
                    waitingConfirmOrders.map((order) => (
                      <div key={order.id} className="customer-order-item">
                        <p className="customer-order-id">ID: {order.productCode}</p>
                        <p className="customer-order-money">{money(order.amount)}</p>
                        <p className="muted">Shop đang kiểm tra chuyển khoản của bạn.</p>
                      </div>
                    ))
                  ) : (
                    <p className="muted">Chưa có đơn nào đang chờ xác nhận.</p>
                  )}
                </div>

                <div className="customer-order-section done">
                  <div className="customer-order-section-title">
                    <b>Đơn đã chốt</b>
                    <span className="customer-order-count">{closedOrders.length} đơn</span>
                  </div>
                  {closedOrders.length ? (
                    closedOrders.map((order) => (
                      <div key={order.id} className="customer-order-item">
                        <p className="customer-order-id">ID: {order.productCode}</p>
                        <p className="customer-order-money">{money(order.amount)}</p>
                        <p className="muted">{statusLabel(order.packed ? "packed" : "unpacked")}</p>
                      </div>
                    ))
                  ) : (
                    <p className="muted">Chưa có đơn đã chốt theo SĐT này.</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="row" style={{ marginBottom: 10 }}><div className="search-box"><SearchIcon /><input className="input search-input" value={search} onChange={(event) => setSearch(event.target.value.replace(/\D/g, ""))} placeholder="Tìm chính xác ID sản phẩm, ví dụ 1..." inputMode="numeric" /></div>{search && <button className="btn secondary small" onClick={() => setSearch("")}>Xóa</button>}</div>
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
        {productLoading && <p className="muted">Đang tải sản phẩm...</p>}
        {!productLoading && sortedProducts.length === 0 && <p className="muted">Không tìm thấy sản phẩm phù hợp.</p>}
        {!search && (productPage > 1 || productHasNextPage) && <div className="pagination"><button className="btn secondary small" disabled={productPage === 1 || productLoading} onClick={onProductPrevPage} aria-label="Trang trước">&lt;</button><button className="btn small active-page">Trang {productPage}</button><button className="btn secondary small" disabled={!productHasNextPage || productLoading} onClick={onProductNextPage} aria-label="Trang sau">&gt;</button></div>}
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

  async function closeExpiredNotice() {
    const order = expiredNoticeOrder;
    clearSavedPaymentOrderId();
    if (order?.id === selectedOrderId) setSelectedOrderId("");
    setExpiredNoticeOrder(null);
    if (order) await handleCancelOrder(order);
    onGoHome?.();
  }
  async function confirmTransferredAfterExpired() { if (!expiredNoticeOrder || isBeyondGrace) return; await handleConfirmTransferred(expiredNoticeOrder); setExpiredNoticeOrder(null); setSelectedOrderId(""); clearSavedPaymentOrderId(); }
  async function confirmCancelPayment() { if (!cancelNoticeOrder) return; await handleCancelOrder(cancelNoticeOrder); setCancelNoticeOrder(null); setSelectedOrderId(""); clearSavedPaymentOrderId(); onGoHome?.(); }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {expiredNoticeOrder && <div className="modal-backdrop"><div className="modal"><h2>Đã hết thời gian chuyển tiền</h2><p className="muted">Đơn <b>{expiredNoticeOrder.productCode}</b> đã quá thời gian thanh toán. Sản phẩm sẽ được mở lại nếu bạn chưa chuyển tiền.</p><p className="muted">Nếu bạn vừa chuyển khoản xong, hãy bấm “Tôi đã chuyển rồi” để gửi thông báo cho shop.</p><div className="row" style={{ justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}><button className="btn secondary modal-home-btn" onClick={closeExpiredNotice}>Trang chủ</button><button className="btn payment-confirm-btn" disabled={isBeyondGrace} style={{ opacity: isBeyondGrace ? .55 : 1, cursor: isBeyondGrace ? "not-allowed" : "pointer" }} onClick={confirmTransferredAfterExpired}>Tôi đã chuyển rồi</button></div></div></div>}
      {cancelNoticeOrder && <div className="modal-backdrop"><div className="modal"><h2>Xác nhận hủy đơn</h2><p>Bạn chắc chắn muốn hủy đơn <b>{cancelNoticeOrder.productCode}</b>?</p><p className="muted">Sau khi hủy, sản phẩm sẽ được mở lại để bạn hoặc khách khác có thể mua.</p><div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}><button className="btn secondary" onClick={() => setCancelNoticeOrder(null)}>Không hủy</button><button className="btn payment-cancel-btn" onClick={confirmCancelPayment}>Hủy đơn</button></div></div></div>}
      {orderToShow ? (
        <>
          <section className="payment-layout">
            <div className="card" style={{ padding: 12 }}>
              <h2 style={{ marginBottom: 8 }}>Thông tin thanh toán</h2>
              <div className="payment-info">
                <InfoLine label="ID sản phẩm" value={orderToShow.productCode} />
                <InfoLine label="SĐT" value={orderToShow.buyerPhone || "-"} />
                <InfoLine label="Giá sản phẩm" value={money(orderToShow.productPrice)} />
                <InfoLine label="Phí ship" value={money(orderToShow.shippingFee)} />
                {Number(orderToShow.shippingFee || 0) > 0 && <p className="shipping-note">Đơn đầu tiên được cộng thêm 20.000đ phí ship.</p>}
                <InfoLine label="Tổng cần chuyển" value={money(orderToShow.amount)} highlight />
                <InfoLine label="Nội dung CK" value={createTransferContent(orderToShow)} />
              </div>
            </div>
            <div className="qr-wrap">
              <img src={createVietQrUrl(orderToShow)} alt="Mã QR chuyển khoản" />
              <div className="qr-timer">{countdown(secondsLeft)}</div>
              <p className="qr-note">Vui lòng chuyển khoản trong thời gian mã QR có hiệu lực</p>
              {Number(orderToShow.shippingFee || 0) > 0 && <p className="shipping-note">Đơn đầu tiên được cộng thêm 20.000đ phí ship.</p>}
            </div>
          </section>
          <div className="payment-top-actions">
            <button className="btn payment-cancel-btn" disabled={isBeyondGrace} style={{ opacity: isBeyondGrace ? .55 : 1, cursor: isBeyondGrace ? "not-allowed" : "pointer" }} onClick={() => !isBeyondGrace && setCancelNoticeOrder(orderToShow)}>Hủy</button>
            <button className="btn payment-confirm-btn" disabled={isBeyondGrace} style={{ opacity: isBeyondGrace ? .55 : 1, cursor: isBeyondGrace ? "not-allowed" : "pointer" }} onClick={() => !isBeyondGrace && handleConfirmTransferred(orderToShow)}>Đã thanh toán</button>
          </div>
        </>
      ) : <section className="card"><p className="muted">Chưa có đơn đang chờ thanh toán.</p></section>}
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
        buyerFullAddress: order.buyerFullAddress || order.buyerOldAddress || [order.buyerAddress, order.buyerWard, order.buyerDistrict, order.buyerProvince].filter(Boolean).join(", "),
        orders: [],
        totalAmount: 0,
        totalShippingFee: 0,
        packed: true,
      };

      current.buyerIg = current.buyerIg || order.buyerIg || "";
      current.buyerFullName = current.buyerFullName || order.buyerFullName || "";
      current.buyerFullAddress = current.buyerFullAddress || order.buyerFullAddress || order.buyerOldAddress || [order.buyerAddress, order.buyerWard, order.buyerDistrict, order.buyerProvince].filter(Boolean).join(", ");
      current.orders.push(order);
      current.totalAmount += Number(order.amount || 0);
      current.totalShippingFee += Number(order.shippingFee || 0);
      current.packed = current.packed && Boolean(order.packed);
      grouped.set(phone, current);
    });

  return Array.from(grouped.values()).sort((a, b) => Number(a.packed) - Number(b.packed));
}

function AdminTabBar({ adminScreen, setAdminScreen, activeCount, unpackedCount }) {
  return (
    <div className="admin-tabs" role="tablist" aria-label="Admin tabs">
      <button className={adminScreen === "main" ? "admin-tab active" : "admin-tab"} onClick={() => setAdminScreen("main")}>
        Admin {activeCount > 0 ? `(${activeCount})` : ""}
      </button>
      <button className={adminScreen === "packing" ? "admin-tab active" : "admin-tab"} onClick={() => setAdminScreen("packing")}>
        Đóng hàng {unpackedCount > 0 ? `(${unpackedCount})` : ""}
      </button>
    </div>
  );
}

function AdminProductCard({ product, handleEditProduct, handleSetProductStatus, handleDeleteProduct }) {
  const displayStatus = getDisplayProductStatus(product);
  return (
    <article className="card product-card admin-product-card">
      <div className="product-main">
        <p className="product-label">ID sản phẩm</p>
        <div className="product-code">{product.idCode}</div>
        <div className="product-price-status">
          <b>{money(product.price)}</b>
          <span className={statusClass(displayStatus)}>{statusLabel(displayStatus)}</span>
        </div>
      </div>
      <div className="admin-actions">
        <button className="icon-btn" title="Sửa" aria-label={`Sửa sản phẩm ${product.idCode}`} onClick={() => handleEditProduct(product)}>✎</button>
        {product.status === "sold" ? (
          <button className="icon-btn warning" title="Mở lại" aria-label={`Mở lại sản phẩm ${product.idCode}`} onClick={() => handleSetProductStatus(product, "available")}>↻</button>
        ) : (
          <>
            <button className="icon-btn success" title="Đánh dấu đã bán" aria-label={`Đánh dấu đã bán ${product.idCode}`} onClick={() => handleSetProductStatus(product, "sold")}>✓</button>
            {product.status !== "available" && (
              <button className="icon-btn warning" title="Mở lại" aria-label={`Mở lại sản phẩm ${product.idCode}`} onClick={() => handleSetProductStatus(product, "available")}>↻</button>
            )}
          </>
        )}
        <button className="icon-btn danger" title="Xóa" aria-label={`Xóa sản phẩm ${product.idCode}`} onClick={() => handleDeleteProduct(product)}>🗑</button>
      </div>
    </article>
  );
}

function AdminView({ adminUnlocked, pin, setPin, loginAdmin, products, activeOrders, closedOrders, showAdminClosedOrders, setShowAdminClosedOrders, productForm, setProductForm, handleAddProduct, handleDeleteProduct, handleEditProduct, cancelEditProduct, handleSetProductStatus, handleConfirmPaid, handleCancelOrder, settings, handleUpdatePaymentMinutes, adminProductSearch, setAdminProductSearch, adminStatusFilter, setAdminStatusFilter, productPage = 1, productHasNextPage = false, productLoading = false, onProductPrevPage, onProductNextPage, adminScreen, setAdminScreen, handleTogglePackedByPhone, requestDeletePackingOrder, requestDeleteAllPackingOrders, requestDeleteAdminProducts, productStats = emptyProductStats(), rebuildProductStats }) {
  const adminKeyword = normalizeProductId(adminProductSearch);
  const packingOrders = useMemo(() => groupOrdersByPhone(closedOrders), [closedOrders]);
  const unpackedCount = packingOrders.filter((group) => !group.packed).length;

  const adminVisibleProducts = useMemo(() => {
    return [...products]
      .filter((product) => !adminKeyword || normalizeProductId(product.idCode) === adminKeyword)
      .filter((product) => {
        const displayStatus = getDisplayProductStatus(product);
        if (adminStatusFilter === "all") return true;
        if (adminStatusFilter === "available") return displayStatus === "available";
        if (adminStatusFilter === "reserved") return ["reserved", "customer_payment", "pending_payment", "waiting_confirm"].includes(displayStatus);
        if (adminStatusFilter === "sold") return displayStatus === "sold";
        return true;
      })
      .sort((a, b) => getProductIdNumber(a.idCode) - getProductIdNumber(b.idCode));
  }, [products, adminKeyword, adminStatusFilter]);

  const pagedAdminProducts = adminVisibleProducts;

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

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <AdminTabBar adminScreen={adminScreen} setAdminScreen={setAdminScreen} activeCount={activeOrders.length} unpackedCount={unpackedCount} />

      {adminScreen === "packing" ? (
        <PackingView packingOrders={packingOrders} onTogglePacked={handleTogglePackedByPhone} onRequestDeleteOrder={requestDeletePackingOrder} onRequestDeleteAll={requestDeleteAllPackingOrders} />
      ) : adminScreen === "confirming" ? (
        <AdminConfirmOrdersView
          activeOrders={activeOrders}
          onBack={() => setAdminScreen("main")}
          handleConfirmPaid={handleConfirmPaid}
          handleCancelOrder={handleCancelOrder}
        />
      ) : (
        <>
          <div className="admin-stats-row">
            <div className="admin-stat"><p className="admin-stat-label">Tổng sản phẩm</p><p className="admin-stat-value">{Number(productStats.totalProducts || 0)}</p></div>
            <div className="admin-stat"><p className="admin-stat-label">Còn hàng</p><p className="admin-stat-value">{Number(productStats.availableProducts || 0)}</p></div>
            <div className="admin-stat"><p className="admin-stat-label">Chờ xác nhận</p><p className="admin-stat-value">{activeOrders.length}</p></div>
            <div className="admin-stat"><p className="admin-stat-label">Đã bán</p><p className="admin-stat-value">{Number(productStats.soldProducts || 0)}</p></div>
            <div className="admin-stat-action">
              <button className="btn secondary admin-sync-btn" title="Quét lại toàn bộ sản phẩm và cập nhật stats/main" onClick={rebuildProductStats}>Đồng bộ</button>
            </div>
          </div>

          <div className="admin-main-grid">
            <section className="card" style={{ height: "fit-content" }}>
              <div className="section-head">
                <div>
                  <h2 className="section-title">{productForm.editingId ? "Sửa sản phẩm" : "Thêm sản phẩm"}</h2>
                  <p className="section-subtitle">ID chỉ nhập số, giá nhập 120 = 120.000đ.</p>
                </div>
              </div>
              <div className="admin-compact-setting">
                <label className="muted">Giữ đơn</label>
                <input className="input" type="number" min="1" max="30" value={settings.paymentMinutes} onChange={(event) => handleUpdatePaymentMinutes(event.target.value)} />
                <span className="muted">phút</span>
              </div>
              <form onSubmit={handleAddProduct}>
                <input className="input" value={productForm.idCode} onChange={(event) => setProductForm({ ...productForm, idCode: event.target.value.replace(/\D/g, "") })} placeholder="ID sản phẩm: 001" inputMode="numeric" />
                <div style={{ height: 10 }} />
                <input className="input" value={productForm.price} onChange={(event) => setProductForm({ ...productForm, price: event.target.value.replace(/\D/g, "") })} placeholder="Giá: nhập 120 = 120.000đ" type="text" inputMode="numeric" />
                {productForm.price && <p className="muted" style={{ margin: "6px 0 0" }}>Giá hiển thị: <b>{money(Number(productForm.price || 0) * 1000)}</b></p>}
                <button className="btn" style={{ width: "100%", marginTop: 10 }}>{productForm.editingId ? "Lưu chỉnh sửa" : "Thêm sản phẩm"}</button>
                {productForm.editingId && <button type="button" className="btn secondary" style={{ width: "100%", marginTop: 8 }} onClick={cancelEditProduct}>Hủy sửa</button>}
              </form>
            </section>

            <div style={{ display: "grid", gap: 14 }}>
              <section className="card admin-pending-summary-card">
                <button className="admin-pending-summary" type="button" onClick={() => setAdminScreen("confirming")}>
                  <div>
                    <h2 className="section-title">Đơn đang chờ xác nhận</h2>
                    <p className="section-subtitle">Bấm vào để xem chi tiết các đơn khách đã báo thanh toán.</p>
                  </div>
                  <div className="admin-pending-count">
                    <b>{activeOrders.length}</b>
                    <span>đơn</span>
                  </div>
                </button>
                {activeOrders.length > 0 ? (
                  <p className="muted" style={{ marginTop: 10 }}>Có {activeOrders.length} đơn cần kiểm tra chuyển khoản.</p>
                ) : (
                  <p className="empty-state" style={{ marginTop: 10 }}>Chưa có đơn đang chờ xác nhận.</p>
                )}
              </section>

              <section className="card">
                <div className="between" style={{ marginBottom: 10 }}>
                  <h2 style={{ margin: 0 }}>Sản phẩm</h2>
                  <button className="btn danger small" disabled={!adminVisibleProducts.length} style={{ opacity: adminVisibleProducts.length ? 1 : .5, cursor: adminVisibleProducts.length ? "pointer" : "not-allowed" }} onClick={() => requestDeleteAdminProducts?.(adminVisibleProducts)}>Xóa tất cả</button>
                </div>
                <div className="admin-product-toolbar">
                  <div className="search-box">
                    <SearchIcon />
                    <input className="input search-input" value={adminProductSearch} onChange={(event) => setAdminProductSearch(event.target.value.replace(/\D/g, ""))} placeholder="Nhập chính xác ID sản phẩm..." inputMode="numeric" />
                  </div>
                  {adminProductSearch && <button className="btn secondary small" onClick={() => setAdminProductSearch("")}>Xóa</button>}
                </div>
                {productLoading && <p className="muted">Đang tải sản phẩm...</p>}
                <div className="grid-products">
                  {pagedAdminProducts.map((product) => (
                    <AdminProductCard key={product.id} product={product} handleEditProduct={handleEditProduct} handleSetProductStatus={handleSetProductStatus} handleDeleteProduct={handleDeleteProduct} />
                  ))}
                </div>
                {adminVisibleProducts.length === 0 && <p className="empty-state">Không tìm thấy sản phẩm phù hợp.</p>}
                {(productPage > 1 || productHasNextPage || productLoading) && (
                  <div className="pagination">
                    <button className="btn secondary small" disabled={productPage === 1 || productLoading} onClick={onProductPrevPage} aria-label="Trang trước">&lt;</button>
                    <button className="btn small active-page" type="button">Trang {productPage}</button>
                    <button className="btn secondary small" disabled={!productHasNextPage || productLoading} onClick={onProductNextPage} aria-label="Trang sau">&gt;</button>
                  </div>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AdminConfirmOrdersView({ activeOrders, onBack, handleConfirmPaid, handleCancelOrder }) {
  const [query, setQuery] = useState("");
  const keyword = query.trim();
  const numericKeyword = normalizeProductId(keyword);

  const visibleOrders = useMemo(() => {
    return activeOrders.filter((order) => {
      if (!keyword) return true;

      if (isNumericSearch(keyword)) {
        return normalizeProductId(order.productCode) === numericKeyword;
      }

      return String(order.buyerFullName || "")
        .toLowerCase()
        .includes(keyword.toLowerCase());
    });
  }, [activeOrders, keyword, numericKeyword]);

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2 className="section-title">Đơn cần xác nhận</h2>
          <p className="section-subtitle">Chi tiết các đơn khách đã bấm “Đã thanh toán”, dùng để đối chiếu chuyển khoản.</p>
        </div>
        <button className="btn secondary small" onClick={onBack}>← Quay lại</button>
      </div>

      <div className="admin-confirm-toolbar">
        <div className="search-box">
          <SearchIcon />
<input
    className="input search-input"
    value={query}
    onChange={(event) => setQuery(event.target.value)}
    placeholder="Nhập chính xác ID hoặc tên người mua..."
/>
        </div>
        {query && <button className="btn secondary small" onClick={() => setQuery("")}>Xóa</button>}
        <span className="status waiting">{visibleOrders.length}/{activeOrders.length} đơn</span>
      </div>

      {visibleOrders.length === 0 ? (
        <p className="empty-state">Không có đơn chờ xác nhận phù hợp.</p>
      ) : (
        visibleOrders.map((order) => (
          <article key={order.id} className="admin-confirm-card">
            <div className="admin-confirm-grid">
              <div>
                <h3 style={{ margin: "0 0 6px", fontSize: 18 }}>ID sản phẩm: {order.productCode}</h3>
                <p className="muted">IG: <b>{order.buyerIg || "-"}</b> · Họ tên: <b>{order.buyerFullName || "-"}</b></p>
                <p className="muted">SĐT: <b>{order.buyerPhone || "-"}</b></p>
                <p className="muted">Nội dung CK: <b>{createTransferContent(order)}</b></p>
                <p className="muted">Địa chỉ: {order.buyerFullAddress || order.buyerOldAddress || [order.buyerAddress, order.buyerWard, order.buyerDistrict, order.buyerProvince].filter(Boolean).join(", ") || "-"}</p>
                <p style={{ margin: "8px 0 0", fontSize: 18 }}><b>{money(order.amount)}</b></p>
              </div>
              <div className="admin-confirm-actions">
                <button className="btn danger small" onClick={() => handleCancelOrder(order)}>Hủy</button>
                <button className="btn success small" onClick={() => handleConfirmPaid(order)}>Đã nhận tiền</button>
              </div>
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function createShippingExcelRows(groups) {
  return groups.map((group) => {
    const firstOrder = Array.isArray(group.orders) ? group.orders[0] || {} : {};
    const fullAddress =
      group.buyerFullAddress ||
      firstOrder.buyerFullAddress ||
      firstOrder.buyerOldAddress ||
      [
        firstOrder.buyerAddress,
        firstOrder.buyerWard,
        firstOrder.buyerDistrict,
        firstOrder.buyerProvince,
      ]
        .filter(Boolean)
        .join(", ");

    // Giữ đúng 25 cột của file mẫu, nhưng chỉ điền:
    // B: Tên khách hàng, C: Số điện thoại, G: Địa chỉ.
    return [
      "",
      group.buyerFullName || firstOrder.buyerFullName || "",
      group.phone || firstOrder.buyerPhone || "",
      "",
      "",
      "",
      fullAddress,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ];
  });
}

async function downloadShippingExcel(groups) {
  if (!groups.length) return false;

  let workbook;
  try {
    const response = await fetch("/shipping-template.xlsx", { cache: "no-store" });
    if (!response.ok) throw new Error(`Không tải được template: ${response.status}`);
    const templateBuffer = await response.arrayBuffer();
    workbook = XLSX.read(templateBuffer, { type: "array", cellStyles: true });
  } catch (error) {
    console.warn("Không đọc được shipping-template.xlsx, tạo workbook dự phòng:", error);
    workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([SHIPPING_TEMPLATE_HEADERS]),
      "Tạo đơn"
    );
  }

  let orderSheet = workbook.Sheets["Tạo đơn"];
  if (!orderSheet) {
    orderSheet = XLSX.utils.aoa_to_sheet([SHIPPING_TEMPLATE_HEADERS]);
    XLSX.utils.book_append_sheet(workbook, orderSheet, "Tạo đơn");
  }

  const exportRows = createShippingExcelRows(groups);
  XLSX.utils.sheet_add_aoa(orderSheet, exportRows, { origin: "A2" });
  orderSheet["!cols"] = orderSheet["!cols"] || [
    { wch: 18 }, { wch: 24 }, { wch: 15 }, { wch: 20 }, { wch: 20 },
    { wch: 20 }, { wch: 38 }, { wch: 24 }, { wch: 14 }, { wch: 24 },
    { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 20 }, { wch: 18 },
    { wch: 28 }, { wch: 28 }, { wch: 24 }, { wch: 16 }, { wch: 16 },
  ];

  const dateText = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `don-dong-hang-${dateText}.xlsx`, { compression: true });
  return true;
}

function PackingView({ packingOrders, onTogglePacked, onRequestDeleteOrder, onRequestDeleteAll }) {
  const [query, setQuery] = useState("");
  const [packingFilter, setPackingFilter] = useState("all");
  const [packingPage, setPackingPage] = useState(1);
  const [copiedPhone, setCopiedPhone] = useState("");

  const totalProducts = packingOrders.reduce((sum, group) => sum + group.orders.length, 0);
  const allPackingOrderItems = packingOrders.flatMap((group) => group.orders);
  const unpackedCount = packingOrders.filter((group) => !group.packed).length;
  const packedCount = packingOrders.length - unpackedCount;
const normalizedQuery = query.trim().toLowerCase();
const visiblePackingOrders = useMemo(() => {
  return packingOrders.filter((group) => {
    const matchStatus =
      packingFilter === "all" ||
      (packingFilter === "packed" ? group.packed : !group.packed);

    if (!normalizedQuery) return matchStatus;

    const matchId = isNumericSearch(normalizedQuery)
      ? group.orders.some(
          (order) => normalizeProductId(order.productCode) === normalizeProductId(normalizedQuery)
        )
      : false;

    const matchName = !isNumericSearch(normalizedQuery) &&
      String(group.buyerFullName || "")
        .toLowerCase()
        .includes(normalizedQuery);

    return matchStatus && (matchId || matchName);
  });
}, [packingOrders, packingFilter, normalizedQuery]);

  const packingTotalPages = Math.max(1, Math.ceil(visiblePackingOrders.length / PACKING_ITEMS_PER_PAGE));
  const paginatedPackingOrders = useMemo(() => {
    const startIndex = (packingPage - 1) * PACKING_ITEMS_PER_PAGE;
    return visiblePackingOrders.slice(startIndex, startIndex + PACKING_ITEMS_PER_PAGE);
  }, [visiblePackingOrders, packingPage]);

  useEffect(() => {
    setPackingPage(1);
  }, [packingFilter, normalizedQuery]);

  useEffect(() => {
    setPackingPage((currentPage) => Math.min(currentPage, packingTotalPages));
  }, [packingTotalPages]);

  function handleDownloadShippingExcel() {
    const groupsToExport = visiblePackingOrders;
    downloadShippingExcel(groupsToExport).then((downloaded) => {
      if (!downloaded) window.alert("Không có đơn phù hợp để xuất Excel.");
    }).catch((error) => {
      console.error("Lỗi xuất Excel:", error);
      window.alert("Không xuất được file Excel. Hãy kiểm tra thư viện xlsx và file template.");
    });
  }

  async function copyCustomerInfo(group) {
    const text = [group.buyerFullName || "", group.phone || "", group.buyerFullAddress || ""].filter(Boolean).join("\n");
    if (!text) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopiedPhone(group.phone);
      window.setTimeout(() => setCopiedPhone(""), 1300);
    } catch (error) {
      console.error("Không copy được thông tin khách:", error);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        <div className="card" style={{ padding: 9, borderRadius: 14, background: "#f8fafc", borderColor: "#e2e8f0", boxShadow: "0 6px 14px rgba(15,23,42,.035)" }}>
          <p className="muted" style={{ margin: "0 0 2px", fontWeight: 850, fontSize: 11 }}>Đơn chưa đóng</p>
          <p style={{ margin: 0, fontSize: 20, fontWeight: 950, color: "#334155", lineHeight: 1.1 }}>{unpackedCount}</p>
        </div>
        <div className="card" style={{ padding: 9, borderRadius: 14, background: "#f0fdf4", borderColor: "#bbf7d0", boxShadow: "0 6px 14px rgba(15,23,42,.035)" }}>
          <p className="muted" style={{ margin: "0 0 2px", fontWeight: 850, fontSize: 11 }}>Đơn đã đóng</p>
          <p style={{ margin: 0, fontSize: 20, fontWeight: 950, color: "#166534", lineHeight: 1.1 }}>{packedCount}</p>
        </div>
      </div>

      <section className="card">
        <div className="packing-toolbar">
          <button className={packingFilter === "all" ? "filter-pill active" : "filter-pill"} onClick={() => setPackingFilter("all")}>
            Tất cả ({packingOrders.length})
          </button>
          <button className={packingFilter === "unpacked" ? "filter-pill active" : "filter-pill"} onClick={() => setPackingFilter("unpacked")}>
            Chưa đóng ({unpackedCount})
          </button>
          <button className={packingFilter === "packed" ? "filter-pill active" : "filter-pill"} onClick={() => setPackingFilter("packed")}>
            Đã đóng ({packedCount})
          </button>

          <button
            type="button"
            className="icon-btn success packing-toolbar-icon"
            disabled={!visiblePackingOrders.length}
            onClick={handleDownloadShippingExcel}
            title={`Tải Excel (${visiblePackingOrders.length} khách hàng)`}
            aria-label={`Tải Excel ${visiblePackingOrders.length} khách hàng`}
            style={{
              marginLeft: "auto",
              opacity: visiblePackingOrders.length ? 1 : .45,
              cursor: visiblePackingOrders.length ? "pointer" : "not-allowed",
            }}
          >
            <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
              <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            type="button"
            className="icon-btn danger packing-toolbar-icon"
            disabled={!allPackingOrderItems.length}
            onClick={() => onRequestDeleteAll(allPackingOrderItems)}
            title="Xóa toàn bộ sản phẩm"
            aria-label="Xóa toàn bộ sản phẩm"
            style={{
              opacity: allPackingOrderItems.length ? 1 : .45,
              cursor: allPackingOrderItems.length ? "pointer" : "not-allowed",
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          <div className="search-box" style={{ width: "100%" }}>
            <SearchIcon />
            <input
              className="input search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nhập chính xác ID hoặc tên người mua..."
            />
          </div>
        </div>

        {packingOrders.length === 0 ? (
          <p className="muted">Chưa có đơn đã chốt để đóng hàng.</p>
        ) : visiblePackingOrders.length === 0 ? (
          <p className="empty-state">Không tìm thấy đơn đóng hàng phù hợp.</p>
        ) : (
          <>
            <div className="packing-list">
              {paginatedPackingOrders.map((group) => {
                const productCount = group.orders.length;
                const productCodes = group.orders.map((order) => order.productCode).filter(Boolean).join(", ");
                return (
                  <article key={group.phone} className="card" style={{ position: "relative", boxShadow: "none", borderColor: group.packed ? "#bbf7d0" : "#c7d2fe", paddingTop: 42 }}>
                    <span className={statusClass(group.packed ? "packed" : "unpacked")} style={{ position: "absolute", top: 12, right: 12 }}>
                      {group.packed ? "Đã đóng hàng" : "Chưa đóng hàng"}
                    </span>

                    <div style={{ minWidth: 0, paddingRight: 8 }}>
                      <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 900 }}>IG: {group.buyerIg || "-"}</p>
                      <div className="row" style={{ alignItems: "center", gap: 6, margin: "0 0 4px" }}>
                        <p style={{ margin: 0, fontSize: 17, fontWeight: 400 }}>{group.buyerFullName || "Chưa có họ tên"}</p>
                        <button className="icon-btn" onClick={() => copyCustomerInfo(group)} title="Copy họ tên, SĐT, địa chỉ" aria-label="Copy thông tin khách" style={{ width: 28, height: 28, borderRadius: 10, flex: "0 0 auto", fontSize: 14 }}>
                          {copiedPhone === group.phone ? "✓" : "⧉"}
                        </button>
                      </div>
                      <p style={{ margin: "0 0 4px", fontWeight: 400 }}>{group.phone || "-"}</p>
                      <p className="muted" style={{ margin: 0, fontWeight: 400 }}>{group.buyerFullAddress || "-"}</p>
                    </div>

                    <div style={{ marginTop: 10 }}>
                      <p className="muted" style={{ margin: "0 0 4px" }}>ID sản phẩm: <b>{productCodes || "-"}</b></p>
                      <p className="muted" style={{ margin: "0 0 4px" }}>{productCount} sản phẩm · Tổng tiền: <b>{money(group.totalAmount)}</b></p>
                      {group.totalShippingFee > 0 && <p className="muted" style={{ margin: 0 }}>Có phí ship: <b>{money(group.totalShippingFee)}</b></p>}
                    </div>

                    <div className="between" style={{ marginTop: 12, alignItems: "center", justifyContent: "flex-end" }}>
                      <button className={group.packed ? "btn secondary" : "btn success"} onClick={() => onTogglePacked(group.phone, !group.packed)}>
                        {group.packed ? "Chuyển chưa đóng" : "Đã đóng hàng"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>

            {packingTotalPages > 1 && (
              <div className="pagination">
                <button className="btn secondary small" disabled={packingPage === 1} onClick={() => setPackingPage((page) => Math.max(1, page - 1))}>
                  Trang trước
                </button>
                <span className="muted" style={{ fontWeight: 850 }}>Trang {packingPage}/{packingTotalPages}</span>
                <button className="btn secondary small" disabled={packingPage === packingTotalPages} onClick={() => setPackingPage((page) => Math.min(packingTotalPages, page + 1))}>
                  Trang sau
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
